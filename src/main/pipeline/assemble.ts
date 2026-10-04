/**
 * ③の結果（または②の下書き）を、確認画面と feedback.md が扱う最終形へ組み立てる。
 * 画像ファイル名の割り当てと、操作ログからの文脈付与（EXT-4）をここで行う。
 *
 * 確認画面での編集（sessions/edits.ts）も最後に `finalizeItems()` を通すので、
 * 番号・画像名・文脈は常にこの1か所で決まる。
 */
import type {
  DraftItem,
  Event,
  FeedbackDocument,
  FeedbackItem,
  FrameRef,
  ItemStatus,
  Material,
  OrganizeOutput,
  Quote,
  SessionMeta
} from './types'
import { buildItemContext } from './context'
import { nearestFrameTime } from './draft'
import { t } from '@shared/i18n'

export interface AssembleOptions {
  /** 画像の拡張子（④で縮小保存する形式） */
  imageExt: string
  /** 「要確認」の指摘を既定で送信対象に含めるか（設計7章4: 既定は外す） */
  includeNeedsCheck: boolean
}

const defaultAssembleOptions: AssembleOptions = {
  imageExt: 'png',
  includeNeedsCheck: false
}

/**
 * 確定前の指摘。index・画像名・contextTime・context は `finalizeItems()` が付ける。
 * 確認画面の編集もこの形で行い、最後に finalize する。
 */
export interface PendingItem {
  id: string
  t: number
  title: string
  request: string
  status: ItemStatus
  quotes: Quote[]
  frameTimes: number[]
  annotationIds: string[]
  draftIds: string[]
  include: boolean
}

/**
 * 番号・画像名・文脈を確定する。
 * - 時刻の順に並べ替えて 1 から番号を振る（並べ替えた一覧は keepOrder でその順のまま）
 * - 使われた静止画の時刻に `01.png` から連番を割り当てる（同じ時刻は同じファイル）
 * - URL・要素・直前の操作は**画像の時刻**から引く（画像と説明が同じ瞬間を指すように。設計5章④）
 */
export function finalizeItems(
  pending: PendingItem[],
  events: Event[],
  options: Partial<AssembleOptions> = {},
  /** 並べ替えた一覧（FeedbackDocument.customOrder）。時刻順に並べ直さず、渡した順に番号を振る */
  keepOrder = false
): FeedbackItem[] {
  const opt = { ...defaultAssembleOptions, ...options }
  const namer = new ImageNamer(opt.imageExt)

  return (keepOrder ? [...pending] : [...pending].sort((a, b) => a.t - b.t))
    .map((it, i) => {
      const ctxTime = it.frameTimes[0] ?? it.t
      return {
        id: it.id,
        index: i + 1,
        t: it.t,
        title: it.title,
        request: it.request,
        status: it.status,
        quotes: it.quotes,
        images: it.frameTimes.map((ft) => namer.nameFor(ft)),
        frameTimes: it.frameTimes,
        contextTime: ctxTime,
        context: buildItemContext(events, ctxTime, it.annotationIds),
        annotationIds: it.annotationIds,
        draftIds: it.draftIds,
        include: it.include
      }
    })
}

/** LLM 出力 → 最終の指摘一覧 */
export function assembleFromOrganized(
  material: Material,
  output: OrganizeOutput,
  options: Partial<AssembleOptions> = {}
): FeedbackDocument {
  const opt = { ...defaultAssembleOptions, ...options }

  const pending: PendingItem[] = output.items.map((it, i) => {
    const frameTimes = resolveFrameTimes(it.frame_times, material.frames)
    return {
      id: `i${i + 1}`,
      t: representativeTime(it.quotes, frameTimes, material.meta),
      title: it.title,
      request: it.request,
      status: it.status,
      quotes: it.quotes,
      frameTimes,
      annotationIds: it.annotation_ids,
      draftIds: [],
      include: it.status === 'decided' || opt.includeNeedsCheck
    }
  })

  return {
    meta: material.meta,
    items: finalizeItems(pending, material.events, opt),
    dropped: output.dropped,
    organizedByLlm: true
  }
}

/** 下書きのまま（LLM未設定・失敗・タイムアウト時のフォールバック。EXT-11） */
export function assembleFromDraft(
  material: Material,
  draft: DraftItem[],
  options: Partial<AssembleOptions> = {}
): FeedbackDocument {
  const opt = { ...defaultAssembleOptions, ...options }

  const pending: PendingItem[] = draft.map((d) => ({
    id: `i-${d.id}`,
    t: d.t,
    // 見出し・要望は作れないので、発話原文をそのまま使う（要望が空だと何を直すのか分からないので、話した全文を入れる）
    title: draftTitle(d),
    request: spokenText(d),
    status: 'decided' as const,
    quotes: d.segments.map((s) => ({ speaker: s.speaker, t: s.t0, text: s.text })),
    frameTimes: d.frameTimes,
    annotationIds: d.annotationIds,
    draftIds: [d.id],
    include: true
  }))

  return {
    meta: material.meta,
    // 話していないペンだけの指摘は、囲んだ要素を見出しにする（どこを囲んだかが一目で分かる）
    items: finalizeItems(pending, material.events, opt).map((item) => {
      const element = item.context.element
      if (item.quotes.length > 0 || !element) return item
      const text = !element.sensitive ? element.text?.replace(/\s+/g, ' ').trim() : ''
      return { ...item, title: t('review.penTitleAt', { target: text ? `“${truncate(text, 40)}”` : element.selector }) }
    }),
    dropped: [],
    organizedByLlm: false
  }
}

/** FeedbackItem を編集できる形へ戻す（確認画面の編集で使う） */
export function toPending(item: FeedbackItem): PendingItem {
  return {
    id: item.id,
    t: item.t,
    title: item.title,
    request: item.request,
    status: item.status,
    quotes: item.quotes,
    frameTimes: item.frameTimes,
    annotationIds: item.annotationIds,
    draftIds: item.draftIds,
    include: item.include
  }
}

function spokenText(d: DraftItem): string {
  return d.segments
    .map((s) => s.text.trim())
    .join(' ')
    .trim()
}

function draftTitle(d: DraftItem): string {
  const spoken = spokenText(d)
  if (spoken) return truncate(spoken, 60)
  // ペンだけの指摘
  return t('review.penFallbackTitle')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/** LLM が返した時刻を、実在する静止画の時刻へ寄せる */
function resolveFrameTimes(times: number[], frames: FrameRef[]): number[] {
  const out: number[] = []
  for (const t of times) {
    const exact = frames.find((f) => f.t === t)
    const resolved = exact ? exact.t : nearestFrameTime(frames, t)
    if (resolved !== undefined && !out.includes(resolved)) out.push(resolved)
  }
  return out.slice(0, 3)
}

function representativeTime(quotes: Quote[], frameTimes: number[], meta: SessionMeta): number {
  const candidates = [...quotes.map((q) => q.t), ...frameTimes].filter(
    (t) => Number.isFinite(t) && t >= 0 && t <= meta.durationMs
  )
  return candidates.length > 0 ? Math.min(...candidates) : 0
}

/** 使われた静止画の時刻に 01.png, 02.png … を割り当てる（同じ時刻は同じファイル） */
class ImageNamer {
  private readonly assigned = new Map<number, string>()
  constructor(private readonly ext: string) {}

  nameFor(t: number): string {
    const existing = this.assigned.get(t)
    if (existing) return existing
    const name = `./${String(this.assigned.size + 1).padStart(2, '0')}.${this.ext}`
    this.assigned.set(t, name)
    return name
  }
}

/**
 * 保存すべき画像の一覧（④で静止画を縮小保存するときに使う）。
 * 送信対象（include）の指摘が参照する静止画だけを返す。
 */
export function imagePlan(
  doc: FeedbackDocument,
  frames: FrameRef[]
): Array<{ name: string; frame: FrameRef; needsCursorRing: boolean }> {
  const byName = new Map<string, FrameRef>()
  for (const it of doc.items) {
    if (!it.include) continue
    for (let i = 0; i < it.images.length; i++) {
      const name = it.images[i]!
      const t = it.frameTimes[i]
      if (t === undefined || byName.has(name)) continue
      const f = frames.find((x) => x.t === t)
      if (f) byName.set(name, f)
    }
  }
  // ペンの書き込みが無い指摘の画像にはカーソルのリングを合成する（EXT-3）
  const ringTimes = new Set(
    doc.items.filter((it) => it.include && !it.context.element).flatMap((it) => it.frameTimes)
  )
  return [...byName.entries()].map(([name, frame]) => ({
    name,
    frame,
    needsCursorRing: ringTimes.has(frame.t) && frame.cursor !== undefined
  }))
}
