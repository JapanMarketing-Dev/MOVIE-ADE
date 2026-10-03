import { describe, expect, it } from 'vitest'
import { mergeTranscripts, singleChannelTranscript } from '../../src/main/pipeline/merge'
import type { TranscriptSegment } from '../../src/main/pipeline/types'

const seg = (t0: number, t1: number, text: string): TranscriptSegment => ({
  t0,
  t1,
  speaker: 'self',
  text,
})

describe('話者のマージと二重取りの除去', () => {
  it('マイク側に話者 self、PC音声側に other を付けて時刻順に並べる', () => {
    const r = mergeTranscripts(
      [seg(5_000, 6_000, '分かりました')],
      [seg(1_000, 3_000, 'ここの色が薄いです')],
    )
    expect(r.segments.map((s) => [s.t0, s.speaker, s.source])).toEqual([
      [1_000, 'other', 'system'],
      [5_000, 'self', 'mic'],
    ])
  })

  it('同時刻・同内容の二重取りは、PC音声側を残してマイク側を捨てる', () => {
    const r = mergeTranscripts(
      [seg(1_150, 3_100, 'ここの色が薄いです')],
      [seg(1_000, 3_000, 'ここの色が薄いです')],
    )
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]!.speaker).toBe('other')
    expect(r.removed).toHaveLength(1)
    expect(r.removed[0]!.segment.text).toBe('ここの色が薄いです')
  })

  it('認識の揺れがあっても二重取りと判定する', () => {
    const r = mergeTranscripts(
      [seg(1_200, 3_000, 'ここの色がうすいです')],
      [seg(1_000, 3_000, 'ここの色が薄いですね')],
    )
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]!.speaker).toBe('other')
  })

  it('マイク側が断片的に拾った場合（PC音声側に含まれる）も除去する', () => {
    // 類似度は低いが、マイク側がPC音声側にそのまま含まれるので二重取りと判定する
    const r = mergeTranscripts(
      [seg(1_300, 2_900, 'このボタン')],
      [seg(1_000, 3_000, 'このボタン、色が薄くて押せるように見えないし、文字も読みにくいです')],
    )
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]!.speaker).toBe('other')
  })

  it('時刻が重なっていなければ、内容が似ていても残す', () => {
    const r = mergeTranscripts(
      [seg(20_000, 22_000, 'ここの色が薄いです')],
      [seg(1_000, 3_000, 'ここの色が薄いです')],
    )
    expect(r.segments).toHaveLength(2)
    expect(r.removed).toHaveLength(0)
  })

  it('時刻が重なっていても内容が違えば両方残す（相槌をまたいだ同時発話）', () => {
    const r = mergeTranscripts(
      [seg(1_000, 3_000, 'じゃあ濃くしますね')],
      [seg(1_000, 3_000, 'このボタンの色が薄いです')],
    )
    expect(r.segments).toHaveLength(2)
  })

  it('PC音声が少し遅れて届いても許容幅の中なら二重取りと判定する', () => {
    const r = mergeTranscripts(
      [seg(1_000, 2_800, 'このボタンの色が薄いです')],
      [seg(1_500, 3_300, 'このボタンの色が薄いです')],
    )
    expect(r.segments).toHaveLength(1)
  })

  it('ごく短い一致（相槌）は内容の包含だけでは除去しない', () => {
    const r = mergeTranscripts(
      [seg(1_000, 1_400, 'はい')],
      [seg(1_000, 4_000, 'はい、それでお願いします')],
    );
    // 「はい」は正規化後2文字で、包含による除去の下限(4文字)に届かない。
    // 類似度も低いので両方残る
    expect(r.segments).toHaveLength(2)
  })

  it('マイク1本に複数人が入る運用では話者を区別しない', () => {
    const r = singleChannelTranscript([seg(2_000, 3_000, 'b'), seg(1_000, 1_500, 'a')])
    expect(r.map((s) => s.text)).toEqual(['a', 'b'])
    expect(r.every((s) => s.speaker === 'self')).toBe(true)
  })
})
