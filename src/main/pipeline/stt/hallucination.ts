/**
 * 文字起こしの幻覚（無音や物音に whisper が付ける決まり文句・効果音のタグ）を落とす。
 *
 * 実測: クリックや机の物音だけの区間に「*claps*」が付き、それがそのまま指摘の見出しになった。
 * - 効果音のタグ（*claps* / [Music] / (applause) / ♪）は話した言葉ではないので、どの音量でも消す
 * - 「Thank you.」「ご視聴ありがとうございました」のような決まり文句は、本当に言うこともあるので、
 *   その区間の音量が小さい（＝話し声が無い）ときだけ捨てる
 * どのエンジン（whisper.cpp・クラウド）の結果にも IncrementalTranscriber が同じように掛ける。
 */
import type { TranscriptSegment } from '../types'
import { dbfs } from './segmenter'

/** 区間の音量がこれ未満なら、決まり文句は無音への幻覚とみなす(dBFS) */
export const QUIET_SEGMENT_DBFS = -36

/** 文中のどこにあっても話し言葉ではないタグ */
const INLINE_TAGS = [/\*[^*\n]{1,40}\*/g, /\[[^\]\n]{1,40}\]/g, /♪[^♪\n]{0,80}♪?/g, /[♪♫]/g]
/** 文全体がそれだけのときに消す、丸括弧のタグ（括弧は話し言葉の補足にも使うので文の途中では消さない） */
const WHOLE_PAREN_TAG = /^[(（][^)）\n]{1,40}[)）]$/

/** 無音に付きやすい決まり文句（句読点を除いて全体が一致するときだけ） */
const SILENCE_PHRASES = [
  /^(?:thank you|thanks)(?: (?:very|so) much)?(?: for watching)?$/i,
  /^(?:please )?(?:like and )?subscribe(?: to (?:my|the|our) channel)?$/i,
  /^(?:you|bye|bye bye|okay|ok)$/i,
  /^(?:ご視聴ありがとうございました|ありがとうございました|おやすみなさい|チャンネル登録(?:お願いします|よろしくお願いします)?)$/,
  /^字幕/
]

/** タグを除いた本文。何も残らなければ空文字 */
export function stripSoundTags(text: string): string {
  let out = text
  for (const re of INLINE_TAGS) out = out.replace(re, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  if (WHOLE_PAREN_TAG.test(out)) return ''
  // 文字も数字も残らなければ（「…」「.」だけなど）話した言葉は無い
  return /[\p{L}\p{N}]/u.test(out) ? out : ''
}

/** 無音に付きやすい決まり文句か */
export function isSilencePhrase(text: string): boolean {
  const bare = text.replace(/[\s.,!?。、！？…"'“”]+/g, ' ').trim()
  return SILENCE_PHRASES.some((re) => re.test(bare))
}

/**
 * 区間の並びから幻覚を落とす。決まり文句の判定には区間の音量が要るので、必要なときだけ loudness を呼ぶ。
 * @param loudness 区間（録画開始からの ms）の音量(dBFS)。分からなければ undefined（そのときは決まり文句も残す）
 */
export async function dropHallucinations(
  segments: TranscriptSegment[],
  loudness: (t0: number, t1: number) => Promise<number | undefined>
): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = []
  for (const segment of segments) {
    const text = stripSoundTags(segment.text)
    if (!text) continue
    if (isSilencePhrase(text)) {
      const level = await loudness(segment.t0, segment.t1)
      if (level !== undefined && level < QUIET_SEGMENT_DBFS) continue
    }
    out.push(text === segment.text ? segment : { ...segment, text })
  }
  return out
}

/** WAV の一部（offsetMs を先頭とする録画時刻 t0〜t1）の音量 */
export function segmentDbfs(samples: Int16Array, sampleRate: number, offsetMs: number, t0: number, t1: number): number {
  const from = Math.max(0, Math.floor(((t0 - offsetMs) / 1000) * sampleRate))
  const to = Math.min(samples.length, Math.ceil(((t1 - offsetMs) / 1000) * sampleRate))
  return dbfs(to > from ? samples.subarray(from, to) : samples)
}
