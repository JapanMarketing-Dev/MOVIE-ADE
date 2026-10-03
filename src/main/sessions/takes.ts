/**
 * 開いているレビューへ、あとから録った分を足す（「このレビューに追加で録る」）。
 *
 * 追記した録画は takes/<n>/ に録り、時刻を「それまでの長さ + TAKE_GAP_MS」だけずらして
 * レビューの1本の時間軸へつなぐ。こうすると編集（edits.ts）・元に戻す・整理・dropped の復元・
 * 画像の差し替えが、録画が1本のときと同じ仕組みのまま動く。
 * 再生だけは時刻から録画を引き戻す（shared/review.ts の takeAt）。
 *
 * Electron に依存しない純粋な処理だけを置く（単体テストから使う）。ファイルの読み書きは src/main/review.ts。
 */
import { basename } from 'node:path'
import { buildDraftDocument } from '../pipeline/decompose'
import { finalizeItems, toPending, type PendingItem } from '../pipeline/assemble'
import type { DraftItem, Event, FeedbackDocument, FrameRef, Material, TranscriptSegment } from '../pipeline/types'
import type { ReviewTake } from '@shared/review'
import { applyEdits } from './edits'
import type { SessionRecord, TakeRecord } from './store'
import { readTrim, type TrimRecord } from './trim'
import { maxOf } from './limits'

/**
 * 録画と録画のあいだに空ける時間（ms）。境目の静止画・操作が隣の録画のものと取り違えられないように。
 * 整理（全体の下書きを作り直す）で前の録画の発話とまとまらないよう、下書きの発話の間隔・ペンの窓（draft.ts）より長くする
 */
export const TAKE_GAP_MS = 5000

/** 追記する録画1本の素材。時刻はこの録画の開始からのミリ秒 */
export interface TakeMaterial {
  /** 2, 3 … */
  n: number
  startedAt: string
  /** 足した時刻（ISO8601） */
  addedAt: string
  durationMs: number
  /** マージ・二重取り除去の後の文字起こし */
  transcript: TranscriptSegment[]
  removedDuplicates: TranscriptSegment[]
  events: Event[]
  /** path は takes/<n>/work/frames のファイル名 */
  frames: FrameRef[]
  warnings: string[]
}

export interface AppendTakeResult {
  record: SessionRecord
  /** レビューの events.jsonl へ足す操作ログ（レビューの時間軸へずらしたもの） */
  events: Event[]
}

/** 次に追記する録画の番号 */
export function nextTakeNumber(record: Pick<SessionRecord, 'takes'>): number {
  // 可変長引数を使わない（takes の件数が多くても投げない）
  return maxOf((Array.isArray(record.takes) ? record.takes : []).map((take) => take?.n), 1) + 1
}

/**
 * 追記した録画の指摘を、既存のレビューの末尾に足す。
 * 既存の指摘・編集・全体への補足・dropped は消さない。指摘とペンの ID には `t<n>-` を付けてレビュー全体で重ならないようにする
 */
export function appendTake(record: SessionRecord, existingEvents: Event[], take: TakeMaterial): AppendTakeResult {
  const offset = Math.max(0, record.meta.durationMs) + TAKE_GAP_MS
  const tag = `t${take.n}-`
  const at = (t: number) => t + offset
  const annotation = (id: string) => `${tag}${id}`
  const segment = (s: TranscriptSegment): TranscriptSegment => ({ ...s, t0: at(s.t0), t1: at(s.t1) })

  const events = take.events.map((e): Event => e.type === 'pen'
    ? { ...e, t: at(e.t), t_end: at(e.t_end), id: annotation(e.id), ...(e.replaces ? { replaces: annotation(e.replaces) } : {}) }
    : e.type === 'erase' ? { ...e, t: at(e.t), ids: e.ids.map(annotation) } : { ...e, t: at(e.t) })
  const frames = take.frames.map((f): FrameRef => ({ ...f, t: at(f.t), path: `takes/${take.n}/${basename(f.path)}`,
    ...(f.annotationId ? { annotationId: annotation(f.annotationId) } : {}) }))

  // 下書きは録画1本ぶんの素材（その録画の時刻）で作り、あとでずらす。前の録画の発話と1件にまとまらないように
  const meta = { ...record.meta, durationMs: take.durationMs }
  const material: Material = { meta, transcript: take.transcript, events: take.events, frames: take.frames }
  const stage = buildDraftDocument(material)

  const draft = stage.draft.items.map((d): DraftItem => ({ ...d, id: `${tag}${d.id}`, t: at(d.t), tEnd: at(d.tEnd),
    segments: d.segments.map(segment), annotationIds: d.annotationIds.map(annotation), frameTimes: d.frameTimes.map(at) }))

  const base = record.originalDocument ?? record.document
  const taken = new Set([...base.items, ...record.document.items].map((it) => it.id))
  const unique = (id: string) => {
    let out = `${tag}${id}`
    for (let i = 2; taken.has(out); i++) out = `${tag}${id}-${i}`
    taken.add(out)
    return out
  }
  const added: PendingItem[] = stage.document.items.map((item) => ({
    ...toPending(item),
    id: unique(item.id),
    t: at(item.t),
    quotes: item.quotes.map((q) => ({ ...q, t: at(q.t) })),
    frameTimes: item.frameTimes.map(at),
    annotationIds: item.annotationIds.map(annotation),
    draftIds: item.draftIds.map((id) => `${tag}${id}`)
  }))

  const allEvents = [...existingEvents, ...events].sort((a, b) => a.t - b.t)
  const allFrames = [...record.frames, ...frames]
  const totalMeta = { ...record.meta, durationMs: offset + Math.max(0, take.durationMs) }
  // 足した分はまだ整理していない（LLM の整理をもう一度かけられるようにする）
  // 整理が付けた名前（reviewTitle）は足した指摘を含まないので外す（自動の名前はルールで作り直す）
  const extend = ({ reviewTitle: _stale, ...doc }: FeedbackDocument): FeedbackDocument => ({ ...doc, meta: totalMeta, organizedByLlm: false,
    items: finalizeItems([...doc.items.map(toPending), ...added], allEvents) })

  // 編集は正本に積み直す（元に戻すと、足した指摘は残ったまま編集だけが戻る）。
  // 正本の無い古いレビューは、今の一覧へそのまま足す（編集を二重にかけない）
  const originalDocument = record.originalDocument ? extend(record.originalDocument) : undefined
  const document = originalDocument
    ? applyEdits({ document: originalDocument, edits: record.edits, events: allEvents, frames: allFrames }).document
    : extend(record.document)

  const entry: TakeRecord = { n: take.n, offsetMs: offset, durationMs: Math.max(0, take.durationMs), startedAt: take.startedAt, addedAt: take.addedAt }
  return {
    events,
    record: {
      ...record,
      meta: totalMeta,
      transcript: [...record.transcript, ...take.transcript.map(segment)],
      removedDuplicates: [...record.removedDuplicates, ...take.removedDuplicates.map(segment)],
      frames: allFrames,
      draft: [...record.draft, ...draft],
      ...(originalDocument ? { originalDocument } : {}),
      document,
      captureGaps: [...(record.captureGaps ?? []), ...take.warnings],
      takes: [...(record.takes ?? []), entry]
    }
  }
}

/**
 * 録画の一覧（最初の録画も含む）。追記していなければ1本だけ。
 * 壊れた takes（数でない・重なる）は飛ばし、開始の順に並べる
 */
export function listTakes(record: Pick<SessionRecord, 'meta' | 'takes' | 'trim'>): Array<Omit<ReviewTake, 'videoUrl' | 'cuts'> & { trim: TrimRecord | null }> {
  const extra = (Array.isArray(record.takes) ? record.takes : [])
    .filter((take) => Number.isInteger(take?.n) && take.n >= 2 && Number.isFinite(take.offsetMs) && Number.isFinite(take.durationMs))
    .sort((a, b) => a.offsetMs - b.offsetMs)
  const firstEnd = extra[0] ? Math.max(0, extra[0].offsetMs - TAKE_GAP_MS) : record.meta.durationMs
  return [
    { n: 1, offsetMs: 0, durationMs: Math.min(record.meta.durationMs, firstEnd), trim: readTrim(record.trim) },
    ...extra.map((take) => ({ n: take.n, offsetMs: take.offsetMs, durationMs: take.durationMs, ...(typeof take.addedAt === 'string' ? { addedAt: take.addedAt } : {}), trim: readTrim(take.trim) }))
  ]
}

/** 時刻 t と同じ録画の静止画だけを返す（画像の差し替えで、別の録画の画面を候補に出さない） */
export function framesOfTake(record: Pick<SessionRecord, 'meta' | 'takes' | 'frames' | 'trim'>, t: number): FrameRef[] {
  const takes = listTakes(record)
  if (takes.length < 2) return record.frames
  const index = takes.reduce((found, take, i) => (take.offsetMs <= t ? i : found), 0)
  const start = takes[index]!.offsetMs
  const end = takes[index + 1]?.offsetMs ?? Number.POSITIVE_INFINITY
  return record.frames.filter((f) => f.t >= start && f.t < end)
}
