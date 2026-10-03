/**
 * 録画の何も起きていない時間を削る計画と、その控え（session.json の trim）。
 * 区間の決め方・時間の対応そのものは shared/trim.ts、削った版の動画を作るのは main/trimVideo.ts。
 *
 * Electron に依存しない純粋な処理だけを置く（単体テストから使う）。
 */
import type { Event, FrameRef, TranscriptSegment } from '../pipeline/types'
import { findIdleCuts, keptSpans, MIN_TOTAL_CUT_MS, sanitizeCuts, totalCut, trimmedDuration, type IdleOptions, type TrimCut } from '@shared/trim'
import type { SessionRecord } from './store'

/** 削った版の控え。時刻は録画1本の中の時間（追記した録画なら、その録画の開始からの ms） */
export interface TrimRecord {
  /** 削った版のファイル名（録画のフォルダの中。recording.trimmed.webm） */
  file: string
  cuts: TrimCut[]
  /** 削ったあとの長さ */
  durationMs: number
  /** 元の録画の長さ */
  sourceDurationMs: number
}

export const TRIMMED_FILE = 'recording.trimmed.webm'

/**
 * 録画を始めた直後の記録（最初の静止画・今のページの遷移と表示幅）は、利用者の操作ではない。
 * これを数えると録画の頭の空白が削れないので、この時間より前の静止画・遷移・表示幅は数えない
 */
export const START_GRACE_MS = 1000

export interface TrimInput {
  durationMs: number
  transcript: TranscriptSegment[]
  events: Event[]
  frames: FrameRef[]
  /**
   * 声の有無が分かっているか。文字起こしが動かなかった・失敗したときは、話していた時間を削ってしまうので削らない
   * （マイクを録っていないときは true）
   */
  speechKnown: boolean
}

/** 何かが起きていた区間（声・書き込み・クリック・スクロール・遷移・画面の変化） */
export function activitySpans(input: Pick<TrimInput, 'transcript' | 'events' | 'frames'>): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const s of input.transcript) if (s.text.trim()) spans.push([s.t0, s.t1])
  for (const e of input.events) {
    if (e.type === 'pen') spans.push([e.t, e.t_end])
    else if (e.type === 'click' || e.type === 'scroll') spans.push([e.t, e.t])
    else if (e.t >= START_GRACE_MS) spans.push([e.t, e.t]) // 遷移・表示幅の切り替え
  }
  // 静止画は画面が変わったときだけ保存される（stills.ts）。画面の変化も「起きていたこと」に数える
  for (const f of input.frames) if (f.t >= START_GRACE_MS) spans.push([f.t, f.t])
  return spans
}

/** 削る区間を決める。削るほどの空白が無い・削れない録画なら null（削った版は作らない） */
export function planTrim(input: TrimInput, options: Partial<IdleOptions> = {}): TrimCut[] | null {
  if (!input.speechKnown) return null
  const cuts = findIdleCuts(activitySpans(input), input.durationMs, options)
  if (totalCut(cuts) < MIN_TOTAL_CUT_MS) return null
  // 残す区間が無くなる計画は使わない（念のため）
  if (!keptSpans(input.durationMs, cuts).length) return null
  return cuts
}

/** 録画 n（1 が最初の録画）の削った版の控えを session.json に書く */
export function withTrim(record: SessionRecord, n: number, cuts: TrimCut[], sourceDurationMs: number): SessionRecord {
  const trim: TrimRecord = { file: TRIMMED_FILE, cuts, durationMs: trimmedDuration(sourceDurationMs, cuts), sourceDurationMs }
  if (n <= 1) return { ...record, trim }
  return { ...record, takes: (record.takes ?? []).map((take) => (take.n === n ? { ...take, trim } : take)) }
}

/** 削った版を作れなかった録画の控え（元の動画のまま使う）。理由は調査用 */
export interface TrimFailure {
  n: number
  reason: string
  at: string
}

/** 録画 n の削った版を作れなかったことを session.json に残す（同じ録画の前の失敗は置き換える） */
export function withTrimFailure(record: SessionRecord, n: number, err: unknown, now = new Date()): SessionRecord {
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500)
  const failures = (Array.isArray(record.trimFailures) ? record.trimFailures : []).filter((f) => f?.n !== n)
  return { ...record, trimFailures: [...failures, { n, reason, at: now.toISOString() }] }
}

/** 削れなかった録画があるか（削った版ができた録画は数えない）。画面に一度だけ知らせるのに使う */
export function hasTrimFailure(record: Pick<SessionRecord, 'trim' | 'takes' | 'trimFailures'>): boolean {
  const failures = Array.isArray(record.trimFailures) ? record.trimFailures : []
  return failures.some((f) => {
    if (!f || !Number.isInteger(f.n)) return false
    const trim = f.n <= 1 ? record.trim : record.takes?.find((take) => take.n === f.n)?.trim
    return !readTrim(trim)
  })
}

/** session.json から読んだ控えを確かめる。壊れていれば無いものとして扱う（元の動画で再生する） */
export function readTrim(raw: unknown): TrimRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<TrimRecord>
  if (r.file !== TRIMMED_FILE || !Number.isFinite(r.sourceDurationMs)) return null
  const cuts = sanitizeCuts(r.cuts)
  if (!cuts.length) return null
  return { file: TRIMMED_FILE, cuts, durationMs: trimmedDuration(r.sourceDurationMs!, cuts), sourceDurationMs: r.sourceDurationMs! }
}

/** 動画の長さ（feedback.md の「収録」に出す）。削った版があれば削ったあとの長さ。録画と録画のすき間は数えない */
export function videoDuration(record: Pick<SessionRecord, 'meta' | 'takes' | 'trim'>, firstDurationMs: number): { originalMs: number; trimmedMs: number } {
  const parts = [{ durationMs: firstDurationMs, trim: readTrim(record.trim) },
    ...(record.takes ?? []).filter((take) => Number.isFinite(take?.durationMs)).map((take) => ({ durationMs: take.durationMs, trim: readTrim(take.trim) }))]
  return {
    originalMs: parts.reduce((sum, p) => sum + p.durationMs, 0),
    trimmedMs: parts.reduce((sum, p) => sum + (p.trim ? p.trim.durationMs : p.durationMs), 0)
  }
}
