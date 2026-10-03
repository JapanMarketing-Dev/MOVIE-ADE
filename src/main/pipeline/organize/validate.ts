/**
 * LLM 出力の検証と正規化（設計5章③「ADE側の検証」）。
 *   - JSON Schema
 *   - 時刻が録画範囲内か
 *   - 引用の時刻が文字起こしに実在するか（本文は文字起こしから引くので捏造しえない）
 *   - 存在しない静止画時刻・ペンID を参照していないか
 *   - 対象（URL・ファイル）をまたいで指摘をまとめていないか。target が欠けている・知らない・根拠と食い違う・
 *     根拠が複数の対象にまたがる場合は、根拠の時刻から引いた元の区切りに戻す（organize/targets.ts）
 * 不合格なら理由を返し、呼び出し側は②の下書きへフォールバックする。
 */
import Ajv from 'ajv'
import type { OrganizedItem, OrganizeInput, OrganizeOutput, Quote, TranscriptSegment } from '../types'
import { organizeOutputSchema } from '../schema'
import type { RawOrganizeOutput } from '../schema'
import { buildTargetIndex, type TargetIndex } from './targets'
import { cleanReviewTitle } from '../../sessions/autoName'

export interface ValidationIssue {
  /** 致命的（この指摘／出力は使えない）か、警告（直して使える）か */
  level: 'error' | 'warning'
  code: string
  message: string;
  /** 指摘の位置（items[i]） */
  itemIndex?: number
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[];
  /** 正規化後の出力（ok のときのみ使う） */
  value?: OrganizeOutput
}

export interface ValidateOptions {
  /** 引用の時刻が文字起こしの区間と一致していると見なす許容幅(ms) */
  quoteToleranceMs: number;
  /** 1指摘あたりの画像の最大枚数 */
  maxFrames: number
}

export const defaultValidateOptions: ValidateOptions = {
  quoteToleranceMs: 1500,
  maxFrames: 3,
}

const ajv = new Ajv({ allErrors: true, strict: false })
/*
 * runner には target を必須で求める（organizeOutputSchema）。ただし検証では欠けを許し、
 * 欠けていれば根拠の時刻から対象を決め直す（古い出力・対象を書き忘れた出力も捨てずに使う）。
 */
const lenientSchema = JSON.parse(JSON.stringify(organizeOutputSchema)) as { required: string[]; properties: { items: { items: { required: string[] } } } }
lenientSchema.properties.items.items.required = lenientSchema.properties.items.items.required.filter((key) => key !== 'target')
// レビューの名前（review_title）も、欠けていればルールの名前を使うので必須にしない
lenientSchema.required = lenientSchema.required.filter((key) => key !== 'review_title')
const validateSchema = ajv.compile(lenientSchema)

export function validateOrganizeOutput(
  raw: unknown,
  input: OrganizeInput,
  options: Partial<ValidateOptions> = {},
): ValidationResult {
  const opt = { ...defaultValidateOptions, ...options }
  const issues: ValidationIssue[] = []

  if (!validateSchema(raw)) {
    for (const e of validateSchema.errors ?? []) {
      issues.push({
        level: 'error',
        code: 'schema',
        message: `${e.instancePath || '/'} ${e.message ?? 'スキーマ不一致'}`,
      })
    }
    return { ok: false, issues }
  }

  const rawOut = raw as unknown as RawOrganizeOutput
  const duration = input.meta.durationMs
  const frameTimes = new Set(input.frameTimes)
  const annotationIds = new Set(
    input.events.filter((e) => e.type === 'pen').map((e) => e.id),
  )

  if (rawOut.items.length === 0) {
    issues.push({ level: 'error', code: 'empty', message: '指摘が1件も返っていない' })
    return { ok: false, issues }
  }

  const badIndexes = new Set<number>()
  /** 生の指摘1件ごとの結果。対象をまたいでいたら複数に分かれる */
  const items: OrganizedItem[][] = []
  const targets = buildTargetIndex(input.events, input.meta)
  const annotationTimes = new Map(
    input.events.filter((e) => e.type === 'pen').map((e) => [e.id, e.t]),
  )

  rawOut.items.forEach((item, i) => {
    const fail = (code: string, message: string) => {
      issues.push({ level: 'error', code, message, itemIndex: i })
      badIndexes.add(i)
    }
    const warn = (code: string, message: string) => {
      issues.push({ level: 'warning', code, message, itemIndex: i })
    }

    if (!item.title.trim()) fail('title-empty', 'title が空')
    if (!item.request.trim()) warn('request-empty', 'request が空');

    // 引用: 時刻から文字起こしの区間を引く。本文と話者は文字起こし側が正しい。
    const quotes: Quote[] = []
    if (item.quote_ts.length === 0) {
      // ペンだけの指摘（発話を伴わない書き込み）は正当なので、ここでは警告に留める。
      // 引用も書き込みも無い場合だけ下の no-valid-quotes で捨てる。
      warn('no-quotes', '引用が無い（書き込みだけの指摘か、根拠の取り違え）')
    }
    for (const t of item.quote_ts) {
      if (t < 0 || t > duration) {
        warn('quote-time-range', `引用の時刻 ${t} が録画範囲(0〜${duration})の外`)
        continue
      }
      const seg = findSegment(input.transcript, t, opt.quoteToleranceMs)
      if (!seg) {
        warn('quote-not-found', `引用の時刻 ${t} に対応する発話が文字起こしに無い`)
        continue
      }
      if (quotes.some((q) => q.t === seg.t0)) continue
      quotes.push({ speaker: seg.speaker, t: seg.t0, text: seg.text })
    }

    // 書き込みID
    const validAnnotations = item.annotation_ids.filter((id) => annotationIds.has(id))
    if (validAnnotations.length < item.annotation_ids.length) {
      warn(
        'annotation-not-found',
        `存在しないペンのIDを参照していた（${item.annotation_ids.length - validAnnotations.length}件）`,
      )
    }

    if (quotes.length === 0 && validAnnotations.length === 0) {
      fail('no-valid-quotes', '有効な引用も書き込みも無い指摘')
    }

    // 静止画の時刻
    let frames = item.frame_times.filter((t) => frameTimes.has(t))
    if (frames.length < item.frame_times.length) {
      warn('frame-not-found', `存在しない静止画時刻を参照していた（${item.frame_times.length - frames.length}件）`)
    }
    // 枚数の上限は、対象で絞ったあと（enforceTarget）で切る
    frames = [...new Set(frames)].sort((a, b) => a - b)
    if (frames.length === 0) {
      warn('frame-empty', '画像の時刻が選ばれていない（引用時刻に最も近い静止画で補う）')
      const t = quotes[0]?.t
      const near = t === undefined ? undefined : nearest(input.frameTimes, t)
      if (near !== undefined) frames = [near]
    }

    items.push(enforceTarget({
      title: item.title.trim(),
      request: item.request.trim(),
      status: item.status,
      quotes,
      frame_times: frames,
      annotation_ids: validAnnotations,
    }, item.target, { targets, annotationTimes, frameTimes: input.frameTimes, maxFrames: opt.maxFrames }, warn))
  });

  // 除外された発話も、時刻から本文を引く（実在しないものは捨てる）
  const dropped: OrganizeOutput['dropped'] = []
  for (const d of rawOut.dropped) {
    if (d.t < 0 || d.t > duration) continue
    const seg = findSegment(input.transcript, d.t, opt.quoteToleranceMs)
    if (!seg) continue
    if (dropped.some((x) => x.t === seg.t0)) continue
    dropped.push({ t: seg.t0, text: seg.text, reason: d.reason })
  }

  const kept = items.filter((_, i) => !badIndexes.has(i)).flat()
  if (kept.length === 0) {
    issues.push({ level: 'error', code: 'all-items-invalid', message: '使える指摘が残らなかった' })
    return { ok: false, issues }
  }

  // レビューの名前は、使えなければ捨てる（履歴の見出しはルールの名前になる）
  const reviewTitle = cleanReviewTitle(rawOut.review_title)
  if (rawOut.review_title !== undefined && !reviewTitle) issues.push({ level: 'warning', code: 'review-title-empty', message: 'review_title が空か意味のない文' })
  return { ok: true, issues, value: { items: kept, dropped, ...(reviewTitle ? { reviewTitle } : {}) } }
}

/**
 * 指摘の対象を、根拠（引用の時刻・書き込みの時刻）から引き直す。
 * - 対象が1つ以下の録画なら何もしない
 * - 根拠が1つの対象にあれば、その対象。target が欠けている・知らない・食い違うときは警告して直す
 * - 根拠が複数の対象にまたがれば、対象ごとの指摘に分ける（違う対象の指摘はまとめない）
 * 画像の時刻も、その対象を開いていた時刻のものだけにする（無ければ、その対象の中で根拠に最も近い静止画）。
 */
export function enforceTarget(
  item: OrganizedItem,
  declared: string | undefined,
  ctx: { targets: TargetIndex; annotationTimes: Map<string, number>; frameTimes: number[]; maxFrames: number },
  warn: (code: string, message: string) => void,
): OrganizedItem[] {
  const { targets } = ctx
  const capped = (frames: number[]) => frames.slice(0, ctx.maxFrames)
  if (targets.spans.length === 0) return [{ ...item, frame_times: capped(item.frame_times) }]

  type Group = { quotes: Quote[]; annotation_ids: string[]; first: number; mark?: number }
  const groups = new Map<string, Group>()
  const add = (id: string | null, t: number, put: (g: Group) => void) => {
    if (!id) return
    const group = groups.get(id) ?? { quotes: [], annotation_ids: [], first: t }
    group.first = Math.min(group.first, t)
    put(group)
    groups.set(id, group)
  }
  for (const q of item.quotes) add(targets.at(q.t), q.t, (g) => g.quotes.push(q))
  for (const id of item.annotation_ids) {
    const t = ctx.annotationTimes.get(id)
    // 書き込みのある指摘は、書き込みが写る時刻の画像を選ぶ
    if (t !== undefined) add(targets.at(t), t, (g) => { g.annotation_ids.push(id); g.mark ??= t })
  }
  if (groups.size === 0) return [{ ...item, frame_times: capped(item.frame_times) }]

  const framesFor = (id: string, near: number): number[] => {
    const own = item.frame_times.filter((t) => targets.at(t) === id)
    if (own.length > 0) return capped(own)
    const candidates = ctx.frameTimes.filter((t) => targets.at(t) === id)
    const best = nearest(candidates, near) ?? nearest(ctx.frameTimes, near)
    return best === undefined ? [] : [best]
  }
  const known = new Set(targets.spans.map((s) => s.id))

  if (groups.size === 1) {
    const [id, group] = [...groups][0]!
    if (!declared) warn('target-missing', `target が無い（根拠の時刻から ${id} とした）`)
    else if (!known.has(declared)) warn('target-unknown', `知らない target「${declared}」（根拠の時刻から ${id} とした）`)
    else if (declared !== id) warn('target-mismatch', `target「${declared}」が根拠の対象 ${id} と食い違う（${id} とした）`)
    return [{ ...item, frame_times: framesFor(id, group.mark ?? group.first) }]
  }

  warn('target-mixed', `違う対象（${[...groups.keys()].join(', ')}）の発話・書き込みを1件にまとめていたので、対象ごとに分けた`)
  return [...groups]
    .sort((a, b) => a[1].first - b[1].first)
    .map(([id, group]) => ({
      ...item,
      quotes: group.quotes,
      annotation_ids: group.annotation_ids,
      frame_times: framesFor(id, group.mark ?? group.first),
    }))
}

/** 指定時刻に対応する文字起こしの区間。完全一致を優先し、無ければ許容幅内で最も近いもの */
function findSegment(
  transcript: TranscriptSegment[],
  t: number,
  toleranceMs: number,
): TranscriptSegment | undefined {
  const exact = transcript.find((s) => s.t0 === t)
  if (exact) return exact
  let best: TranscriptSegment | undefined
  let bestD = Infinity
  for (const s of transcript) {
    // 区間の中に入っていれば距離0
    const d = t >= s.t0 && t <= s.t1 ? 0 : Math.min(Math.abs(s.t0 - t), Math.abs(s.t1 - t))
    if (d < bestD) {
      best = s
      bestD = d
    }
  }
  return bestD <= toleranceMs ? best : undefined
}

function nearest(values: number[], t: number): number | undefined {
  let best: number | undefined
  let bestD = Infinity
  for (const v of values) {
    const d = Math.abs(v - t)
    if (d < bestD) {
      best = v
      bestD = d
    }
  }
  return best
}
