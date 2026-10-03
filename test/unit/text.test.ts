import { describe, expect, it } from 'vitest'
import { containsNormalized, formatDurationJa, formatTimecode, normalizeJa, similarity } from '../../src/main/pipeline/text'
import { extractJson } from '../../src/main/pipeline/organize/spawn'

describe('日本語の正規化と類似度', () => {
  it('記号・空白・全角半角・ひらがなカタカナの揺れを吸収する', () => {
    expect(normalizeJa('この ボタン、色が薄い。')).toBe(normalizeJa('このボタン色が薄い'))
    expect(normalizeJa('ＣＳＶ')).toBe('csv')
    expect(similarity('えーっと', 'エーット')).toBe(1)
  })

  it('同じ内容なら1、無関係なら低い値になる', () => {
    expect(similarity('色が薄いです', '色が薄いです')).toBe(1)
    expect(similarity('色が薄いです', '余白を詰めてください')).toBeLessThan(0.3)
    expect(similarity('', '')).toBe(1)
    expect(similarity('あ', '')).toBe(0)
  })

  it('正規化後の包含を判定できる', () => {
    expect(containsNormalized('このボタン、色が薄くて押せない', '色が薄く')).toBe(true)
    expect(containsNormalized('短い', '')).toBe(false)
  })
})

describe('時刻の表示', () => {
  it('mm:ss 形式', () => {
    expect(formatTimecode(0)).toBe('00:00')
    expect(formatTimecode(14_200)).toBe('00:14')
    expect(formatTimecode(252_000)).toBe('04:12')
    expect(formatTimecode(-5)).toBe('00:00')
  })

  it('「4分12秒」形式', () => {
    expect(formatDurationJa(252_000)).toBe('4分12秒')
    expect(formatDurationJa(42_000)).toBe('42秒')
  })
})

describe('LLM出力からのJSON取り出し', () => {
  it('素のJSONをそのまま返す', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}')
  })

  it('コードフェンスと前置きを剥がす', () => {
    expect(extractJson('はい、結果です。\n```json\n{"a":1}\n```\n')).toBe('{"a":1}')
  })

  it('JSONが無ければ例外', () => {
    expect(() => extractJson('できませんでした')).toThrow()
    expect(() => extractJson('   ')).toThrow()
  })
})
