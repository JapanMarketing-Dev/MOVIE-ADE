/**
 * 内蔵ブラウザのログインの組（src/shared/browserProfile.ts）。既定は全プロジェクトで共有し、名前を付けたプロジェクトだけ分ける
 */
import { describe, expect, it } from 'vitest'
import { MAX_BROWSER_PROFILE_LENGTH, SHARED_BROWSER_PARTITION, browserPartition, browserProfiles, sanitizeBrowserProfile } from '../../src/shared/browserProfile'

describe('ログインの組', () => {
  it('名前が無ければ共有の組（今までと同じ persist:ade-browser）', () => {
    expect(SHARED_BROWSER_PARTITION).toBe('persist:ade-browser')
    for (const v of [undefined, null, '', '   ', '\u0000']) expect(browserPartition(v as string | undefined)).toBe('persist:ade-browser')
  })

  it('同じ名前（大文字小文字・前後と連続の空白・全角半角の違いは同じ）は同じ組、違う名前は別の組。session の名前は英数字だけ', () => {
    const a = browserPartition('Client A')
    expect(a).toMatch(/^persist:ade-browser-[0-9a-f]{16}$/)
    expect(browserPartition(' client  a ')).toBe(a)
    expect(browserPartition('ＣＬＩＥＮＴ Ａ')).toBe(a)
    expect(browserPartition('Client B')).not.toBe(a)
    expect(browserPartition('株式会社ほげ')).toMatch(/^persist:ade-browser-[0-9a-f]{16}$/)
  })

  it('名前は制御文字を落とし、長さの上限で切る。読めない値は共有', () => {
    expect(sanitizeBrowserProfile('  Acme\n Corp ')).toBe('Acme Corp')
    expect(sanitizeBrowserProfile('x'.repeat(100))).toHaveLength(MAX_BROWSER_PROFILE_LENGTH)
    expect(sanitizeBrowserProfile(42)).toBeUndefined()
  })

  it('設定に出す組の一覧は重複なく名前の順', () => {
    expect(browserProfiles([{ browserProfile: 'Beta' }, {}, { browserProfile: 'alpha' }, { browserProfile: 'BETA' }])).toEqual(['alpha', 'Beta'])
  })
})
