import { describe, expect, it } from 'vitest'
import { isHtmlPath, isProjectPageUrl, projectPageUrl, projectPathFromPageUrl } from '../../src/shared/htmlPreview'

/**
 * HTML を内蔵ブラウザで開くときの ade-page://project/ の URL（@shared/htmlPreview。security-7 [2][6]）。
 * 作った URL を Chromium が読んだ形（new URL）から、同じ相対パスに戻せることと、外へ出る形を断ることを固定する。
 */
describe('isHtmlPath', () => {
  it('.html / .htm だけ（大文字も）', () => {
    expect(isHtmlPath('index.html')).toBe(true)
    expect(isHtmlPath('docs/A.HTM')).toBe(true)
    expect(isHtmlPath('page.html.md')).toBe(false)
    expect(isHtmlPath('README.md')).toBe(false)
    expect(isHtmlPath('app.xhtml')).toBe(false)
  })
})

describe('projectPageUrl', () => {
  it('相対パスを区切りごとに符号化する（空白・# ・? ・% を含む名前も開ける）', () => {
    expect(projectPageUrl('docs/index.html')).toBe('ade-page://project/docs/index.html')
    const url = projectPageUrl('a #1/b?c%d.html')
    expect(url).toBe('ade-page://project/a%20%231/b%3Fc%25d.html')
    expect(new URL(url).hash).toBe('')
    expect(new URL(url).search).toBe('')
    expect(projectPageUrl('pages\\index.html')).toBe('ade-page://project/pages/index.html')
    expect(isProjectPageUrl(url)).toBe(true)
    expect(isProjectPageUrl('file:///Users/taro/site/index.html')).toBe(false)
  })
})

describe('projectPathFromPageUrl', () => {
  it('作った URL から相対パスに戻る（Chromium が直した形でも）', () => {
    for (const rel of ['docs/index.html', 'a #1/b?c%d.html', 'ページ/説明.html']) {
      expect(projectPathFromPageUrl(new URL(projectPageUrl(rel)).href), rel).toBe(rel)
    }
  })

  it('クエリ・ハッシュは見ない', () => {
    expect(projectPathFromPageUrl('ade-page://project/index.html?x=1#top')).toBe('index.html')
  })

  it('外へ出る形・違うスキーム・違うホスト・壊れた符号は null', () => {
    expect(projectPathFromPageUrl('ade-page://project/%2E%2E/secret.html')).toBe('secret.html')
    expect(projectPathFromPageUrl('ade-page://project/a%2F..%2F..%2Fsecret.html')).toBeNull()
    expect(projectPathFromPageUrl('ade-page://project/a%5Cb.html')).toBeNull()
    expect(projectPathFromPageUrl('ade-page://project/a%00.html')).toBeNull()
    expect(projectPathFromPageUrl('ade-page://project/')).toBeNull()
    expect(projectPathFromPageUrl('ade-page://other/index.html')).toBeNull()
    expect(projectPathFromPageUrl('file:///Users/taro/site/index.html')).toBeNull()
    expect(projectPathFromPageUrl('ade-preview://project/index.html')).toBeNull()
    expect(projectPathFromPageUrl('ade-page://project/%E3%81.html')).toBeNull()
    expect(projectPathFromPageUrl('not a url')).toBeNull()
  })
})
