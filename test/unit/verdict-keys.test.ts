import { describe, expect, it } from 'vitest'
import { verdictKeySends } from '../../src/shared/verdictKeys'

const key = (over: Partial<Parameters<typeof verdictKeySends>[0]> = {}) => ({ key: 'Enter', shiftKey: false, altKey: false, isComposing: false, keyCode: 13, ...over })

describe('確認待ちのコメント欄のキー', () => {
  it('Enter と ⌘/Ctrl+Enter で送る', () => {
    expect(verdictKeySends(key())).toBe(true)
    expect(verdictKeySends(key({ keyCode: 13 }))).toBe(true)
  })
  it('日本語の変換を確定する Enter では送らない（isComposing・keyCode 229）', () => {
    expect(verdictKeySends(key({ isComposing: true }))).toBe(false)
    expect(verdictKeySends(key({ keyCode: 229 }))).toBe(false)
  })
  it('Shift+Enter・Alt+Enter は改行で、送らない。Enter 以外も送らない', () => {
    expect(verdictKeySends(key({ shiftKey: true }))).toBe(false)
    expect(verdictKeySends(key({ altKey: true }))).toBe(false)
    expect(verdictKeySends(key({ key: 'a' }))).toBe(false)
  })
})
