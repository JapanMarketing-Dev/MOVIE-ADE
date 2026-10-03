/**
 * 話者のマージと二重取りの除去（02_requirements.md AUD-2 / AUD-3、03_design.md 4章「音声（MTG）」）
 *
 * マイク系統（自分）と PC音声系統（相手）を別々に文字起こしし、時刻でマージする。
 * スピーカー使用時にマイクが相手の声を拾った重複は、PC音声側を残してマイク側を捨てる。
 */
import type { TranscriptSegment } from './types'
import { similarity, containsNormalized } from './text'

export interface MergeOptions {
  /** 二重取りと見なす時間の重なり比（マイク側の長さに対する重なりの割合） */
  minOverlapRatio: number;
  /** 二重取りと見なすテキスト類似度 */
  minSimilarity: number;
  /** PC音声の遅延を吸収する許容幅(ms)。スピーカー経由は少し遅れて届く */
  toleranceMs: number
}

export const defaultMergeOptions: MergeOptions = {
  minOverlapRatio: 0.5,
  minSimilarity: 0.6,
  toleranceMs: 700,
}

export interface MergeResult {
  segments: TranscriptSegment[];
  /** 二重取りとして捨てたマイク側の発話（検証・デバッグ用） */
  removed: Array<{ segment: TranscriptSegment; matchedText: string; similarity: number }>
}

function overlapMs(a: TranscriptSegment, b: TranscriptSegment, tolerance: number): number {
  const lo = Math.max(a.t0, b.t0 - tolerance)
  const hi = Math.min(a.t1, b.t1 + tolerance)
  return Math.max(0, hi - lo)
}

/**
 * マイク系統とPC音声系統をマージする。
 *
 * @param mic   マイク（自分）の文字起こし。speaker は 'self' で入ってくる想定
 * @param system PC音声（相手）の文字起こし。speaker は 'other'
 */
export function mergeTranscripts(
  mic: TranscriptSegment[],
  system: TranscriptSegment[],
  options: Partial<MergeOptions> = {},
): MergeResult {
  const opt = { ...defaultMergeOptions, ...options }

  const micSegs = mic.map((s) => ({ ...s, speaker: 'self' as const, source: 'mic' as const }))
  const sysSegs = system.map((s) => ({ ...s, speaker: 'other' as const, source: 'system' as const }))

  const removed: MergeResult['removed'] = []
  const kept: TranscriptSegment[] = []

  for (const m of micSegs) {
    const dup = findDuplicate(m, sysSegs, opt)
    if (dup) {
      removed.push({ segment: m, matchedText: dup.seg.text, similarity: dup.score })
    } else {
      kept.push(m)
    }
  }

  const segments = [...kept, ...sysSegs].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1)
  return { segments, removed }
}

function findDuplicate(
  m: TranscriptSegment,
  sysSegs: TranscriptSegment[],
  opt: MergeOptions,
): { seg: TranscriptSegment; score: number } | undefined {
  const micLen = Math.max(1, m.t1 - m.t0)
  let best: { seg: TranscriptSegment; score: number } | undefined

  for (const s of sysSegs) {
    const ov = overlapMs(m, s, opt.toleranceMs)
    if (ov / micLen < opt.minOverlapRatio) continue;

    // マイクは相手の声を途切れ途切れに拾うため、類似度に加えて
    // 「マイク側がPC音声側の一部にそのまま含まれる」場合も二重取りと見なす。
    const score = similarity(m.text, s.text)
    const contained = normalizedLength(m.text) >= 4 && containsNormalized(s.text, m.text)
    if (score >= opt.minSimilarity || contained) {
      const effective = contained ? Math.max(score, opt.minSimilarity) : score
      if (!best || effective > best.score) best = { seg: s, score: effective }
    }
  }
  return best
}

function normalizedLength(s: string): number {
  return s.replace(/[\s　]/g, '').length
}

/**
 * マイク1本に複数人が入る運用（対面MTG）。話者は区別しない（AUD-2 後段）。
 * 'self' として扱うが source を付けないことで、下流で話者名を出さない判断ができる。
 */
export function singleChannelTranscript(mic: TranscriptSegment[]): TranscriptSegment[] {
  return mic
    .map((s) => ({ ...s, speaker: 'self' as const, source: 'mic' as const }))
    .sort((a, b) => a.t0 - b.t0)
}
