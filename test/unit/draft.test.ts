import { describe, expect, it } from 'vitest'
import { buildDraft, defaultDraftOptions, nearestFrameTime, nearestFrameTimeAfter } from '../../src/main/pipeline/draft'
import type { Event, FrameRef, Material, TranscriptSegment } from '../../src/main/pipeline/types'
import { frames, material, meta } from './fixtures'

describe('下書き（ルール）', () => {
  it('間隔が2秒未満の発話を1つのまとまりにし、2秒以上で分ける', () => {
    const { items } = buildDraft(material);
    // 4区間 → 3件（最初の2区間が結合）＋ペンだけの指摘1件 = 4件
    const speech = items.filter((i) => i.origin === 'speech')
    expect(speech).toHaveLength(3)
    expect(speech[0]!.segments.map((s) => s.text)).toEqual([
      'この見出しが小さいですね',
      'もう少し大きくしてください',
    ])
    expect(speech[1]!.segments.map((s) => s.text)).toEqual(['このボタンの色が薄いです'])
  })

  it('時刻が重なるペンを、その発話のまとまりに付ける', () => {
    const { items } = buildDraft(material)
    const withPen = items.find((i) => i.annotationIds.includes('p3'))
    expect(withPen?.segments.map((s) => s.text)).toEqual(['このボタンの色が薄いです'])
  })

  it('置かれたテキストを前後3秒以内の発話に付ける', () => {
    const { items } = buildDraft(material)
    const withText = items.find((i) => i.annotationIds.includes('x1'))
    expect(withText?.segments.map((s) => s.text)).toEqual(['表記がばらばらです'])
  })

  it('近い発話が無い書き込みは単独の指摘にする', () => {
    const { items } = buildDraft(material)
    const orphan = items.find((i) => i.annotationIds.includes('p9'))
    expect(orphan).toBeDefined()
    expect(orphan!.origin).toBe('annotation')
    expect(orphan!.segments).toHaveLength(0)
  })

  it('発話も書き込みも無い区間は指摘にしない', () => {
    const empty: Material = { meta, transcript: [], events: [], frames }
    expect(buildDraft(empty).items).toHaveLength(0)
  })

  it('ペンがあればその確定時刻の静止画、無ければ発話開始時刻の静止画を選ぶ', () => {
    const { items } = buildDraft(material)
    const withPen = items.find((i) => i.annotationIds.includes('p3'))!
    expect(withPen.frameTimes).toEqual([19_750]); // p3 の t_end=19650 に最も近い

    const noAnnotation = items.find((i) => i.segments[0]?.t0 === 2_000)!
    expect(noAnnotation.annotationIds).toHaveLength(0)
    expect(noAnnotation.frameTimes).toEqual([3_000]); // 発話開始 2000 に最も近い
  })

  it('対象（ページ）を切り替えたら、間隔が短くても別のまとまりにする', () => {
    const transcript: TranscriptSegment[] = [
      { t0: 11_000, t1: 12_500, speaker: 'self', text: '料金を見ます', source: 'mic' },
      { t0: 13_500, t1: 15_000, speaker: 'self', text: 'この表が読みにくい', source: 'mic' },
    ]
    const framesWithStart: FrameRef[] = [{ t: 11_100, path: 'work/start.png' }, ...frames]
    const { items } = buildDraft({ meta, transcript, events: material.events, frames: framesWithStart })
    // 間隔は1秒だが、13000 に トップ → 料金 の遷移があるので2つに分かれる
    // （素材の書き込みは別の時刻なので、発話のまとまりだけを見る）
    const spoken = items.filter((i) => i.segments.length > 0)
    expect(spoken.map((i) => i.segments.map((s) => s.text))).toEqual([['料金を見ます'], ['この表が読みにくい']])
    expect(spoken[0]!.frameTimes).toEqual([11_100])
  })

  it('1つの発話の途中でURLが変わったら、変化後の静止画を足す', () => {
    const transcript: TranscriptSegment[] = [
      { t0: 11_000, t1: 15_000, speaker: 'self', text: '料金を開いて、この表が読みにくい', source: 'mic' },
    ]
    const framesWithStart: FrameRef[] = [{ t: 11_100, path: 'work/start.png' }, ...frames]
    const { items } = buildDraft({ meta, transcript, events: material.events, frames: framesWithStart })
    // 発話開始(11000)に近い静止画 ＋ nav(13000) 以降の静止画
    expect(items[0]!.frameTimes).toEqual([11_100, 13_200])
  })

  it('書き込みは同じページのまとまりにだけ付ける', () => {
    const events: Event[] = [
      { t: 0, type: 'nav', url: 'http://localhost:3000/', title: 'トップ' },
      { t: 9_000, type: 'text', id: 'x1', x: 10, y: 10, body: 'ここの余白' },
      { t: 10_000, type: 'nav', url: 'ade-preview://project/docs/a.md', title: 'a.md' },
    ]
    const transcript: TranscriptSegment[] = [
      { t0: 10_500, t1: 12_000, speaker: 'self', text: 'この手順が分かりにくい', source: 'mic' },
    ]
    const { items } = buildDraft({ meta, transcript, events, frames })
    // 書き込み(9000)は発話(10500)と1.5秒しか離れていないが、ページが違うので別の指摘になる
    expect(items.map((i) => [i.annotationIds, i.segments.length])).toEqual([[['x1'], 0], [[], 1]])
  })

  it('画像は最大3枚まで', () => {
    const manyNavs: Event[] = [
      { t: 0, type: 'nav', url: 'http://x/0', title: '0' },
      { t: 1_200, type: 'nav', url: 'http://x/1', title: '1' },
      { t: 2_200, type: 'nav', url: 'http://x/2', title: '2' },
      { t: 3_200, type: 'nav', url: 'http://x/3', title: '3' },
      { t: 4_200, type: 'nav', url: 'http://x/4', title: '4' },
    ]
    const manyFrames: FrameRef[] = Array.from({ length: 12 }, (_, i) => ({ t: i * 500, path: `f${i}.png` }))
    const transcript: TranscriptSegment[] = [
      { t0: 500, t1: 1_500, speaker: 'self', text: 'あ', source: 'mic' },
      { t0: 2_000, t1: 5_000, speaker: 'self', text: 'いろいろ変わりますね', source: 'mic' },
    ]
    const { items } = buildDraft({ meta, transcript, events: manyNavs, frames: manyFrames })
    expect(items[0]!.frameTimes.length).toBeLessThanOrEqual(3)
  })

  it('書き込みが無く、ごく短い取りこぼしの発話は捨てる', () => {
    const transcript: TranscriptSegment[] = [
      { t0: 1_000, t1: 1_200, speaker: 'self', text: 'ん', source: 'mic' },
      { t0: 10_000, t1: 12_000, speaker: 'self', text: 'ここが読みにくい', source: 'mic' },
    ]
    const { items } = buildDraft({ meta, transcript, events: [], frames })
    expect(items).toHaveLength(1)
    expect(items[0]!.segments[0]!.text).toBe('ここが読みにくい')
  })

  it('掛け合いが続くMTGでも、まとまりが上限の長さを超えない', () => {
    // 2人が1.2秒間隔で120秒話し続ける（間隔の規則だけなら1つのまとまりになる）
    const transcript: TranscriptSegment[] = []
    for (let i = 0; i < 40; i++) {
      const t0 = i * 3000
      transcript.push({
        t0,
        t1: t0 + 1800,
        speaker: i % 2 === 0 ? 'other' : 'self',
        text: `発話${i}です。ここを直してください`,
        source: i % 2 === 0 ? 'system' : 'mic',
      })
    }
    const longMeta = { ...meta, durationMs: 130_000, twoSpeakers: true }

    const naive = buildDraft({ meta: longMeta, transcript, events: [], frames }, { maxClusterMs: Infinity })
    expect(naive.items).toHaveLength(1); // 上限が無いと全体が1件になる

    const { items } = buildDraft({ meta: longMeta, transcript, events: [], frames })
    expect(items.length).toBeGreaterThan(3)
    for (const it of items) {
      expect(it.tEnd - it.t).toBeLessThanOrEqual(defaultDraftOptions.maxClusterMs)
    }
    // 発話を落とさない
    expect(items.reduce((n, it) => n + it.segments.length, 0)).toBe(transcript.length)
  })

  it('IDは d1 から連番で振る', () => {
    const { items } = buildDraft(material)
    expect(items.map((i) => i.id)).toEqual(items.map((_, i) => `d${i + 1}`))
  })
})

describe('静止画の選択', () => {
  it('確定前の画像が時刻で近くても、文字が描画済みの関連画像を選ぶ', () => {
    const events: Event[] = [{ type: 'text', id: 'x1', t: 1000, x: 10, y: 20, body: 'ボタンを濃くしてください' }]
    const frames: FrameRef[] = [{ t: 995, path: 'empty-input' }, { t: 1050, path: 'painted-text', annotationId: 'x1' }]
    const result = buildDraft({ meta, events, frames, transcript: [] })
    expect(result.items[0]?.frameTimes).toEqual([1050])
  })
  it('最も近い時刻を選び、同距離なら後ろを取る', () => {
    const fs: FrameRef[] = [{ t: 1_000, path: 'a' }, { t: 3_000, path: 'b' }]
    expect(nearestFrameTime(fs, 1_100)).toBe(1_000)
    expect(nearestFrameTime(fs, 2_000)).toBe(3_000)
    expect(nearestFrameTime([], 100)).toBeUndefined()
  })

  it('指定時刻以降の最初の静止画を返す', () => {
    const fs: FrameRef[] = [{ t: 1_000, path: 'a' }, { t: 3_000, path: 'b' }]
    expect(nearestFrameTimeAfter(fs, 1_500)).toBe(3_000)
    expect(nearestFrameTimeAfter(fs, 5_000)).toBeUndefined()
  })
})
