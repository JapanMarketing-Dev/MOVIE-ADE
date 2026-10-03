/**
 * LLM 出力の検証と正規化（設計5章③「ADE側の検証」）。
 *   - JSON Schema
 *   - 時刻が録画範囲内か
 *   - 引用の時刻が文字起こしに実在するか（本文は文字起こしから引くので捏造しえない）
 *   - 存在しない静止画時刻・ペンID を参照していないか
 * 不合格なら理由を返し、呼び出し側は②の下書きへフォールバックする。
 */
import Ajv from 'ajv'
import type { OrganizeInput, OrganizeOutput, Quote, TranscriptSegment } from '../types'
import { organizeOutputSchema } from '../schema'
import type { RawOrganizeOutput } from '../schema'

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
const validateSchema = ajv.compile(organizeOutputSchema)

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

  const rawOut = raw as RawOrganizeOutput
  const duration = input.meta.durationMs
  const frameTimes = new Set(input.frameTimes)
  const annotationIds = new Set(
    input.events.filter((e) => e.type === 'pen' || e.type === 'text').map((e) => (e as { id: string }).id),
  )

  if (rawOut.items.length === 0) {
    issues.push({ level: 'error', code: 'empty', message: '指摘が1件も返っていない' })
    return { ok: false, issues }
  }

  const badIndexes = new Set<number>()
  const items: OrganizeOutput['items'] = []

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
      // ペン・テキストだけの指摘（発話を伴わない書き込み）は正当なので、ここでは警告に留める。
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
        `存在しないペン・テキストIDを参照していた（${item.annotation_ids.length - validAnnotations.length}件）`,
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
    frames = [...new Set(frames)].sort((a, b) => a - b).slice(0, opt.maxFrames)
    if (frames.length === 0) {
      warn('frame-empty', '画像の時刻が選ばれていない（引用時刻に最も近い静止画で補う）')
      const t = quotes[0]?.t
      const near = t === undefined ? undefined : nearest(input.frameTimes, t)
      if (near !== undefined) frames = [near]
    }

    items.push({
      title: item.title.trim(),
      request: item.request.trim(),
      status: item.status,
      quotes,
      frame_times: frames,
      annotation_ids: validAnnotations,
    })
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

  const kept = items.filter((_, i) => !badIndexes.has(i))
  if (kept.length === 0) {
    issues.push({ level: 'error', code: 'all-items-invalid', message: '使える指摘が残らなかった' })
    return { ok: false, issues }
  }

  return { ok: true, issues, value: { items: kept, dropped } }
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
