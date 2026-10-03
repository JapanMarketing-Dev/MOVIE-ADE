import { describe, expect, it } from 'vitest'
import { classifyDiskChange, sameJson, sameText } from '@shared/diskChange'

const saved = '{\n  "theme": "light",\n  "language": "ja"\n}\n'
// main が読み直して整形し直した書き戻し（インデントとキーの並びが違うだけ）
const normalized = '{\n    "language": "ja",\n    "theme": "light"\n}'

describe('ディスク側の変更の扱い（自分の保存では警告しない）', () => {
  it('自分の保存の直後の知らせ（ディスク＝エディタ）は無視する', () => {
    expect(classifyDiskChange({ disk: saved, baseline: saved, current: saved, json: true })).toBe('ignore')
    // 保存の途中に届いた（基準はまだ古い）場合も、中身が同じなら無視する
    expect(classifyDiskChange({ disk: saved, baseline: '{}', current: saved, json: true })).toBe('ignore')
  })

  it('改行・空白だけ違うなら、外からの変更とみなさない', () => {
    const crlf = saved.replace(/\n/g, '\r\n')
    const compact = '{"theme":"light","language":"ja"}'
    // 改行コードと末尾の改行だけの違いは、JSON でなくても自分の保存
    expect(classifyDiskChange({ disk: crlf, baseline: saved, current: saved, json: true })).toBe('ignore')
    expect(classifyDiskChange({ disk: crlf.trimEnd(), baseline: saved, current: saved })).toBe('ignore')
    expect(classifyDiskChange({ disk: compact, baseline: saved, current: saved, json: true })).toBe('adopt')
  })

  it('保存した内容を main が整形し直して書き戻しただけなら、黙って取り込む', () => {
    expect(classifyDiskChange({ disk: normalized, baseline: saved, current: saved, json: true })).toBe('adopt')
    // 読み直しで「変更あり」と取り違えた状態（基準が古い）でも、意味が同じなら警告しない
    expect(classifyDiskChange({ disk: normalized, baseline: '{}', current: saved, json: true })).toBe('adopt')
  })

  it('整形し直して書き戻した後に、もう一度知らせが来ても警告しない', () => {
    // 1回目で取り込んだあと（基準もエディタも整形後の文）
    expect(classifyDiskChange({ disk: normalized, baseline: normalized, current: normalized, json: true })).toBe('ignore')
  })

  it('編集していなければ、外からの変更は取り込む', () => {
    const external = '{ "theme": "dark" }'
    expect(classifyDiskChange({ disk: external, baseline: saved, current: saved, json: true })).toBe('reload')
  })

  it('編集中に外から中身が変わったら、上書きせずに知らせる', () => {
    const editing = saved.replace('"ja"', '"en"')
    const external = saved.replace('"light"', '"dark"')
    expect(classifyDiskChange({ disk: external, baseline: saved, current: editing, json: true })).toBe('conflict')
  })

  it('編集中にディスク側が整形し直されただけなら、編集を残して警告しない', () => {
    const editing = saved.replace('"ja"', '"en"')
    expect(classifyDiskChange({ disk: normalized, baseline: saved, current: editing, json: true })).toBe('keep')
  })

  it('JSON として比べないファイルでは、書き方の違いも変更とみなす', () => {
    expect(classifyDiskChange({ disk: normalized, baseline: saved, current: saved })).toBe('reload')
    expect(classifyDiskChange({ disk: normalized, baseline: saved, current: saved + 'x' })).toBe('conflict')
  })
})

describe('sameText（改行コードと末尾の改行だけの違いは同じ）', () => {
  const text = '{\n  "theme": "light"\n}\n'

  it('同じ内容・改行コードと末尾の改行だけ違うものは同じ', () => {
    expect(sameText(text, text)).toBe(true)
    expect(sameText(text.replace(/\n/g, '\r\n'), text)).toBe(true)
    expect(sameText('{\n  "theme": "light"\n}', text)).toBe(true)
    expect(sameText(text, '{\r\n  "theme": "light"\r\n}')).toBe(true)
  })

  it('中身が違う・途中の改行の数が違うものは別', () => {
    expect(sameText('{\n  "theme": "dark"\n}\n', text)).toBe(false)
    expect(sameText('{\n\n  "theme": "light"\n}\n', text)).toBe(false)
  })
})

describe('sameJson', () => {
  it('空白とキーの並びは無視し、値と配列の順は区別する', () => {
    expect(sameJson('{"a":1,"b":[1,2]}', '{ "b": [1, 2], "a": 1 }')).toBe(true)
    expect(sameJson('{"b":[1,2]}', '{"b":[2,1]}')).toBe(false)
    expect(sameJson('{"a":1}', '{"a":"1"}')).toBe(false)
  })

  it('読めない JSON は同じとみなさない', () => {
    expect(sameJson('{', '{')).toBe(false)
  })
})
