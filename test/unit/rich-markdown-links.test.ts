/**
 * Markdown のプレビューのリンクを押すと外部のブラウザで開く（src/renderer/editor/richMarkdown/links.ts）。
 * 開くのは http(s) の絶対 URL だけ。ページ内・相対・javascript: などは開かない（main の app:openExternal はさらに https だけを通す）
 */
import { describe, expect, it } from 'vitest'
import { clickedLinkHref } from '../../src/renderer/editor/richMarkdown/links'

/** closest('a[href]') だけを持つ要素の代わり */
const inLink = (href: string | null) => ({ closest: (sel: string) => (sel === 'a[href]' && href !== null ? { getAttribute: () => href } : null) })

describe('プレビューのリンク', () => {
  it('https と http の絶対 URL を返す（前後の空白は除く）', () => {
    expect(clickedLinkHref(inLink('https://support.console.aws.amazon.com/support/home#/case/?displayId=1') as unknown as EventTarget)).toBe('https://support.console.aws.amazon.com/support/home#/case/?displayId=1')
    expect(clickedLinkHref(inLink('  HTTP://localhost:5173/a ') as unknown as EventTarget)).toBe('HTTP://localhost:5173/a')
  })

  it('リンクの外・ページ内・相対・危ないスキームは null（編集のクリックのまま）', () => {
    for (const href of [null, '', '#top', './other.md', '/abs/path', 'javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@example.com', 'data:text/html,x'])
      expect(clickedLinkHref(inLink(href) as unknown as EventTarget), String(href)).toBeNull()
    expect(clickedLinkHref(null)).toBeNull()
    expect(clickedLinkHref({} as EventTarget)).toBeNull()
  })
})
