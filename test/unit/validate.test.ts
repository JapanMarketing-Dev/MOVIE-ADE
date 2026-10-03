import { describe, expect, it } from 'vitest'
import { validateOrganizeOutput } from '../../src/main/pipeline/organize/validate'
import { buildDraft } from '../../src/main/pipeline/draft'
import type { RawOrganizeOutput } from '../../src/main/pipeline/schema'
import type { OrganizeInput } from '../../src/main/pipeline/types'
import { material } from './fixtures'

const input: OrganizeInput = {
  meta: material.meta,
  transcript: material.transcript,
  events: material.events,
  frameTimes: material.frames.map((f) => f.t),
  draft: buildDraft(material).items,
}

const base = (): RawOrganizeOutput => ({
  items: [
    {
      title: 'ボタンの色が薄い',
      request: '申し込むボタンの色を濃くする',
      status: 'decided',
      quote_ts: [18_000],
      frame_times: [19_750],
      annotation_ids: ['p3'],
    },
  ],
  dropped: [],
})

describe('LLM出力の検証と正規化', () => {
  it('正しい出力を通し、引用の本文と話者を文字起こしから埋める', () => {
    const r = validateOrganizeOutput(base(), input)
    expect(r.ok).toBe(true)
    expect(r.issues.filter((i) => i.level === 'error')).toHaveLength(0)
    expect(r.value!.items[0]!.quotes).toEqual([
      { speaker: 'self', t: 18_000, text: 'このボタンの色が薄いです' },
    ])
  })

  it('スキーマに合わない出力を落とす', () => {
    const r = validateOrganizeOutput({ items: [{ title: 'x' }], dropped: [] }, input)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'schema')).toBe(true)
  })

  it('引用に本文を書いてきた（スキーマ外のキー）出力を落とす', () => {
    const out = {
      items: [
        {
          title: 'x',
          request: 'y',
          status: 'decided',
          quote_ts: [18_000],
          quotes: [{ speaker: 'self', t: 18_000, text: '捏造' }],
          frame_times: [19_750],
          annotation_ids: [],
        },
      ],
      dropped: [],
    }
    expect(validateOrganizeOutput(out, input).ok).toBe(false)
  })

  it('JSONでない値を落とす', () => {
    expect(validateOrganizeOutput('{}', input).ok).toBe(false)
    expect(validateOrganizeOutput(null, input).ok).toBe(false)
  })

  it('指摘が0件なら不合格にする', () => {
    const r = validateOrganizeOutput({ items: [], dropped: [] }, input)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'empty')).toBe(true)
  })

  it('録画範囲の外の時刻の引用を落とす', () => {
    const out = base()
    out.items[0]!.quote_ts = [999_999]
    const r = validateOrganizeOutput(out, input)
    expect(r.issues.some((i) => i.code === 'quote-time-range')).toBe(true);
    // ペン(p3)が残っているので、引用だけ落として指摘自体は使える
    expect(r.ok).toBe(true)
    expect(r.value!.items[0]!.quotes).toHaveLength(0)
  })

  it('引用が範囲外で書き込みも無ければ、その指摘を捨てる', () => {
    const out = base()
    out.items[0]!.quote_ts = [999_999]
    out.items[0]!.annotation_ids = []
    const r = validateOrganizeOutput(out, input)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'no-valid-quotes')).toBe(true)
  })

  it('引用の時刻が少しずれていても、許容幅内なら対応する発話に寄せる', () => {
    const out = base()
    out.items[0]!.quote_ts = [19_000]; // 18000〜21000 の区間の中
    const r = validateOrganizeOutput(out, input)
    expect(r.value!.items[0]!.quotes[0]!.t).toBe(18_000)
  })

  it('どの発話にも対応しない時刻の引用を落とす', () => {
    const out = base()
    out.items[0]!.quote_ts = [50_000]
    const r = validateOrganizeOutput(out, input)
    expect(r.issues.some((i) => i.code === 'quote-not-found')).toBe(true)
    expect(r.value!.items[0]!.quotes).toHaveLength(0)
  })

  it('同じ発話を2回引用しても1つにまとめる', () => {
    const out = base()
    out.items[0]!.quote_ts = [18_000, 19_500]
    const r = validateOrganizeOutput(out, input)
    expect(r.value!.items[0]!.quotes).toHaveLength(1)
  })

  it('存在しない静止画時刻を落とし、引用時刻に近い静止画で補う', () => {
    const out = base()
    out.items[0]!.frame_times = [12_345, 99_999]
    const r = validateOrganizeOutput(out, input)
    expect(r.ok).toBe(true)
    expect(r.issues.some((i) => i.code === 'frame-not-found')).toBe(true)
    expect(r.value!.items[0]!.frame_times).toEqual([19_750])
  })

  it('存在しないペンIDを落とす', () => {
    const out = base()
    out.items[0]!.annotation_ids = ['p3', 'p999']
    const r = validateOrganizeOutput(out, input)
    expect(r.ok).toBe(true)
    expect(r.value!.items[0]!.annotation_ids).toEqual(['p3'])
    expect(r.issues.some((i) => i.code === 'annotation-not-found')).toBe(true)
  })

  it('画像は3枚までに切る', () => {
    const out = base()
    out.items[0]!.frame_times = [0, 3_000, 13_200, 19_750, 25_400]
    const r = validateOrganizeOutput(out, input)
    expect(r.value!.items[0]!.frame_times).toHaveLength(3)
  })

  it('ペン・テキストだけの指摘（発話なし）は、引用が無くても通す', () => {
    const out = base()
    out.items[0]! = {
      title: 'ペンで囲んだ箇所',
      request: 'この箇所を直す',
      status: 'decided',
      quote_ts: [],
      frame_times: [41_100],
      annotation_ids: ['p9'],
    }
    const r = validateOrganizeOutput(out, input)
    expect(r.ok).toBe(true)
    expect(r.value!.items).toHaveLength(1)
    expect(r.issues.some((i) => i.code === 'no-quotes' && i.level === 'warning')).toBe(true)
  })

  it('引用が無い指摘は捨て、残りを使う', () => {
    const out = base()
    out.items.push({
      title: '勝手に作った指摘',
      request: 'なにか',
      status: 'decided',
      quote_ts: [],
      frame_times: [0],
      annotation_ids: [],
    })
    const r = validateOrganizeOutput(out, input)
    expect(r.ok).toBe(true)
    expect(r.value!.items).toHaveLength(1)
    expect(r.value!.items[0]!.title).toBe('ボタンの色が薄い')
  })

  it('除外された発話の本文を文字起こしから埋め、実在しないものは捨てる', () => {
    const out = base()
    out.dropped = [
      { t: 2_000, reason: 'つなぎ言葉' },
      { t: 50_000, reason: '実在しない時刻' },
      { t: 999_999, reason: '範囲外' },
    ]
    const r = validateOrganizeOutput(out, input)
    expect(r.value!.dropped).toEqual([
      { t: 2_000, text: 'この見出しが小さいですね', reason: 'つなぎ言葉' },
    ])
  })

  it('全部の指摘が不合格なら ok:false を返す（下書きへフォールバックする）', () => {
    const out = base()
    out.items[0]!.quote_ts = []
    out.items[0]!.annotation_ids = []
    const r = validateOrganizeOutput(out, input)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'all-items-invalid')).toBe(true)
  })

  it('title が空の指摘を捨てる', () => {
    const out = base()
    out.items[0]!.title = '  '
    expect(validateOrganizeOutput(out, input).ok).toBe(false)
  })
})
