import { describe, expect, it } from 'vitest'
import { isHtmlPath, projectFileUrl, projectPathFromFileUrl } from '../../src/shared/htmlPreview'

/**
 * HTML を内蔵ブラウザで開くときの file:// の URL（@shared/htmlPreview）。
 * 作った URL を Chromium が読んだ形（new URL）から、同じプロジェクトの相対パスに戻せることを固定する。
 * Windows のパスは文字列として扱うだけで、ファイルは作らない。
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

describe('projectFileUrl', () => {
  it('macOS / Linux のパス', () => {
    expect(projectFileUrl('/Users/taro/site', 'docs/index.html')).toBe('file:///Users/taro/site/docs/index.html')
    expect(projectFileUrl('/Users/taro/site/', 'index.html')).toBe('file:///Users/taro/site/index.html')
  })

  it('区切りごとに符号化する（空白・# ・? ・% を含む名前も開ける）', () => {
    const url = projectFileUrl('/w/my site', 'a #1/b?c%d.html')
    expect(url).toBe('file:///w/my%20site/a%20%231/b%3Fc%25d.html')
    expect(new URL(url).hash).toBe('')
    expect(new URL(url).search).toBe('')
  })

  it('Windows のドライブと UNC', () => {
    expect(projectFileUrl('C:\\work\\site', 'pages\\index.html')).toBe('file:///C:/work/site/pages/index.html')
    expect(projectFileUrl('\\\\server\\share\\site', 'a.html')).toBe('file://server/share/site/a.html')
  })
})

describe('projectPathFromFileUrl', () => {
  it('作った URL から相対パスに戻る（Chromium が直した形でも）', () => {
    for (const [root, rel] of [
      ['/Users/taro/site', 'docs/index.html'],
      ['/w/my site', 'a #1/b?c%d.html'],
      ['/w/日本語', 'ページ/説明.html'],
      ['C:\\work\\site', 'pages/index.html'],
      ['\\\\server\\share\\site', 'a.html']
    ] as const) {
      expect(projectPathFromFileUrl(new URL(projectFileUrl(root, rel)).href, root), `${root} ${rel}`).toBe(rel)
    }
  })

  it('クエリ・ハッシュは見ない', () => {
    expect(projectPathFromFileUrl('file:///Users/taro/site/index.html?x=1#top', '/Users/taro/site')).toBe('index.html')
  })

  it('Windows ではドライブ名・フォルダ名の大文字小文字を区別しない', () => {
    expect(projectPathFromFileUrl('file:///c:/Work/Site/index.html', 'C:\\work\\site')).toBe('index.html')
  })

  it('macOS / Linux では大文字小文字を区別する', () => {
    expect(projectPathFromFileUrl('file:///users/taro/site/index.html', '/Users/taro/site')).toBeNull()
  })

  it('プロジェクトの外・名前が前だけ同じフォルダ・ほかのスキーム・プロジェクト無しは null', () => {
    expect(projectPathFromFileUrl('file:///Users/taro/other/index.html', '/Users/taro/site')).toBeNull()
    expect(projectPathFromFileUrl('file:///Users/taro/site2/index.html', '/Users/taro/site')).toBeNull()
    expect(projectPathFromFileUrl('file:///Users/taro/site', '/Users/taro/site')).toBeNull()
    expect(projectPathFromFileUrl('file:///Users/taro/site/', '/Users/taro/site')).toBeNull()
    expect(projectPathFromFileUrl('http://localhost:3000/index.html', '/Users/taro/site')).toBeNull()
    expect(projectPathFromFileUrl('ade-preview://project/index.html', '/Users/taro/site')).toBeNull()
    expect(projectPathFromFileUrl('file:///Users/taro/site/index.html', null)).toBeNull()
    expect(projectPathFromFileUrl('not a url', '/Users/taro/site')).toBeNull()
  })

  it('.. で外へ出る URL は外とみなす（URL は正規化されて外のパスになる）', () => {
    expect(projectPathFromFileUrl('file:///Users/taro/site/../secret.html', '/Users/taro/site')).toBeNull()
  })

  it('壊れた % の並びは null', () => {
    expect(projectPathFromFileUrl('file:///Users/taro/site/%E3%81.html', '/Users/taro/site')).toBeNull()
  })
})
