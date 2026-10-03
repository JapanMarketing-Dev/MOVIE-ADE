import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOWNLOAD_BASE, SITE_URL } from '../../site/js/config.js'

/**
 * サイトのリンクの開き方の約束（site/js/app.js の externalLink() と同じ線引き）:
 *   - 外部（自サイト以外）の http(s) リンクは新しいタブで開く。ただしインストーラ本体（R2 の配布ファイル）は同じタブのまま
 *   - サイト内のリンク（相対パス・アンカー・自サイトの URL）は、フッターも含めて同じタブで開く
 * 新しいタブで開くリンクは target="_blank" と rel に noopener を持つ。
 * フッターに GitHub Issues へのリンクは置かない（本文からのリンクはよい）。
 */
const SITE = resolve(__dirname, '../../site')
const files = [
  ...readdirSync(SITE).filter((f) => f.endsWith('.html')).map((f) => join(SITE, f)),
  ...readdirSync(join(SITE, 'docs')).filter((f) => f.endsWith('.html')).map((f) => join(SITE, 'docs', f)),
]
const OWN = ['https://movie-ade.japan-marketing.co.jp', 'https://movie-ade.pages.dev', SITE_URL]

const anchors = (html: string) => [...html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0])
const hrefOf = (tag: string) => /\shref="([^"]*)"/.exec(tag)?.[1] ?? ''
const opensNewTab = (tag: string) => /\starget="_blank"/.test(tag) && /\srel="[^"]*\bnoopener\b[^"]*"/.test(tag)
const isInstaller = (href: string) => href.startsWith(DOWNLOAD_BASE) && /\.(dmg|exe|AppImage|deb|zip)$/i.test(href)

describe.each(files.map((f) => [f.slice(SITE.length + 1), f]))('%s', (_name, file) => {
  const html = readFileSync(file, 'utf8')
  const footer = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? ''

  it('サイト内のリンクは新しいタブで開かない', () => {
    const internal = anchors(html).filter((a) => {
      const href = hrefOf(a)
      return !/^[a-z]+:/i.test(href) || OWN.some((own) => href.startsWith(own))
    })
    expect(internal.filter((a) => /\starget="_blank"/.test(a))).toEqual([])
  })

  it('外部リンクは新しいタブで開く（インストーラ本体を除く）', () => {
    const external = anchors(html).filter((a) => {
      const href = hrefOf(a)
      return /^https?:\/\//.test(href) && !OWN.some((own) => href.startsWith(own)) && !isInstaller(href)
    })
    expect(external.filter((a) => !opensNewTab(a))).toEqual([])
  })

  it('フッターに GitHub Issues へのリンクが無い', () => {
    expect(footer).not.toMatch(/github\.com\/[^"]*\/issues/)
  })
})
