import { describe, expect, it } from 'vitest'
import { isHashRoute, isPageChange, pageKey } from '../../../src/main/recording/page'

/**
 * 書き込み（ペン・テキスト）はその画面だけのもの。
 * ページが変わったら消し、ハッシュだけの移動では残す（PEN-3 / TXT-2 の拡張）。
 */
describe('ページが変わったかの判定', () => {
  it('パスが変われば、別のページ', () => {
    expect(isPageChange('https://example.com/pricing', 'https://example.com/about')).toBe(true)
  })

  it('クエリが変われば、別のページ', () => {
    expect(isPageChange('https://example.com/list?page=1', 'https://example.com/list?page=2')).toBe(true)
    expect(isPageChange('https://example.com/list', 'https://example.com/list?q=a')).toBe(true)
  })

  it('オリジンが変われば、別のページ', () => {
    expect(isPageChange('http://localhost:3000/', 'http://localhost:4000/')).toBe(true)
    expect(isPageChange('https://dev.example.com/a', 'https://example.com/a')).toBe(true)
  })

  it('ハッシュだけの変化は、同じページ（書き込みを残す）', () => {
    expect(isPageChange('https://example.com/docs', 'https://example.com/docs#install')).toBe(false)
    expect(isPageChange('https://example.com/docs#a', 'https://example.com/docs#b')).toBe(false)
    expect(isPageChange('https://example.com/docs?v=1#a', 'https://example.com/docs?v=1')).toBe(false)
  })

  it('ハッシュでルーティングするSPA（#/ と #!/）の遷移は、別のページ', () => {
    expect(isPageChange('https://example.com/#/users', 'https://example.com/#/settings')).toBe(true)
    expect(isPageChange('https://example.com/#!/users', 'https://example.com/#!/users/1')).toBe(true)
    expect(isPageChange('https://example.com/', 'https://example.com/#/users')).toBe(true)
    expect(isPageChange('https://example.com/#/users', 'https://example.com/#section')).toBe(true)
    // 同じルートのままなら同じページ
    expect(isPageChange('https://example.com/#/users', 'https://example.com/#/users')).toBe(false)
  })

  it('ルートの形でないハッシュ（#! だけ・#section）はアンカー扱い', () => {
    expect(isPageChange('https://example.com/a', 'https://example.com/a#!')).toBe(false)
    expect(isHashRoute('#section')).toBe(false)
    expect(isHashRoute('#/')).toBe(true)
    expect(isHashRoute('#!/x')).toBe(true)
  })

  it('同じURLへの移動（再読み込み相当）は、同じページ', () => {
    expect(isPageChange('https://example.com/a?x=1', 'https://example.com/a?x=1')).toBe(false)
  })

  it('末尾の「?」の有無は同じページ', () => {
    expect(isPageChange('https://example.com/a?', 'https://example.com/a')).toBe(false)
  })

  it('前のURLが無い・about:blank のときは、消すものが無いので変わっていない扱い', () => {
    expect(isPageChange('', 'https://example.com/')).toBe(false)
    expect(isPageChange(null, 'https://example.com/')).toBe(false)
    expect(isPageChange(undefined, 'https://example.com/')).toBe(false)
    expect(isPageChange('about:blank', 'https://example.com/')).toBe(false)
  })

  it('file: のページも、パスで比べる', () => {
    expect(isPageChange('file:///site/index.html', 'file:///site/about.html')).toBe(true)
    expect(isPageChange('file:///site/index.html', 'file:///site/index.html#top')).toBe(false)
  })

  it('ファイルのプレビュー（ade-preview:）も、パスが変われば別のページ', () => {
    expect(isPageChange('ade-preview://project/docs/a.md', 'ade-preview://project/docs/b.md')).toBe(true)
    expect(isPageChange('ade-preview://project/docs/a.md', 'ade-preview://project/docs/a.md#h2')).toBe(false)
    expect(isPageChange('http://localhost:3000/', 'ade-preview://project/docs/a.md')).toBe(true)
  })

  it('URLとして読めない文字列でも、ハッシュを除いて比べる', () => {
    expect(pageKey('not a url#x')).toBe('not a url')
    expect(isPageChange('not a url#x', 'not a url#y')).toBe(false)
    expect(isPageChange('not a url', 'other')).toBe(true)
    expect(isPageChange('not a url#/a', 'not a url#/b')).toBe(true)
  })
})
