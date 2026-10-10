import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SITE_URL } from '../../site/js/config.js'

/** 検索エンジン向けの約束ごと（サイトマップ・robots.txt・構造化データ・IndexNow の鍵）。ずれたら pnpm site:meta */
const SITE = resolve(__dirname, '../../site')
const read = (p: string) => readFileSync(join(SITE, p), 'utf8')
const pages = [
  ...readdirSync(SITE).filter((f) => f.endsWith('.html') && f !== '404.html'),
  ...readdirSync(join(SITE, 'docs'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.html')).map((f) => `docs/${f.split('\\').join('/')}`)
]
/** meta refresh で移るだけのページ（サイトマップには載せず、/docs/ はサーバーで転送する） */
const isRedirect = (p: string) => /http-equiv="refresh"/.test(read(p))
/** まだ訳の無い docs/<lang>/ のページ（英語の本文を出す）。検索には載せず、canonical は英語のページ */
const isNoindex = (p: string) => /<meta name="robots" content="noindex/.test(read(p))
const englishOf = (p: string) => p.replace(/^docs\/[\w-]+\//, 'docs/')
const pagePath = (p: string) => (p === 'index.html' ? '/' : p.endsWith('/index.html') ? `/${p.slice(0, -10)}` : `/${p.replace(/\.html$/, '')}`)

describe('サイトマップ', () => {
  const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])

  it('404 を除く全ページを、canonical と同じ URL で1回ずつ載せる（訳の無い言語のページは載せず、canonical は英語）', () => {
    const expected = pages.filter((p) => !isRedirect(p) && !isNoindex(p)).map((p) => SITE_URL + pagePath(p)).sort()
    expect([...locs].sort()).toEqual(expected)
    for (const p of pages) {
      expect(/<link rel="canonical" href="([^"]*)"/.exec(read(p))?.[1]).toBe(SITE_URL + pagePath(isNoindex(p) ? englishOf(p) : p))
    }
  })

  it('robots.txt がサイトマップを指す', () => {
    expect(read('robots.txt')).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`)
    expect(read('robots.txt')).not.toMatch(/Disallow:\s*\/\s*$/m)
  })
})

describe('ちらつきと欠けの防止', () => {
  const all = [...pages, '404.html']

  it('<use href="#…"> の絵は、同じページの sprite にある（無いとヘッダーのアイコンが空になる）', () => {
    for (const p of all) {
      const html = read(p)
      const missing = [...html.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]).filter((id) => !html.includes(`<symbol id="${id}"`))
      expect({ page: p, missing }).toEqual({ page: p, missing: [] })
    }
  })

  it('Docs への入口は /docs/ ではなく quick-start を直接指し、/docs/ はサーバーで転送する', () => {
    for (const p of all) expect({ page: p, bad: /href="(\.\/|\/)?docs\/"/.test(read(p)) }).toEqual({ page: p, bad: false })
    expect(read('_redirects')).toMatch(/^\/docs\/ \/docs\/quick-start 301$/m)
    // 言語版の docs も、入口（/docs/<lang>/）は描く前に quick-start へ送る
    expect(read('_redirects')).toContain('/docs/ja/ /docs/ja/quick-start 301')
    // やめた言語（0.6.14）の URL は英語のページへ送る
    for (const lang of ['zh-CN', 'zh-TW', 'ko', 'es', 'fr', 'de', 'it', 'pt-BR', 'ru', 'hi', 'id', 'vi'])
      expect(read('_redirects')).toContain(`/docs/${lang}/* /docs/:splat 301`)
  })
})

describe('構造化データ', () => {
  it('トップページに SoftwareApplication の JSON-LD があり、URL は SITE_URL から作る', () => {
    const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read('index.html'))?.[1]
    const data = JSON.parse(raw ?? 'null')
    expect(data).toMatchObject({ '@type': 'SoftwareApplication', name: 'Ferret', url: `${SITE_URL}/` })
    expect(data.offers).toMatchObject({ price: '0' })
  })
})

describe('IndexNow と配信の設定', () => {
  it('鍵のファイルが1つだけあり、中身はファイル名と同じ', () => {
    const keys = readdirSync(SITE).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f))
    expect(keys).toHaveLength(1)
    expect(read(keys[0])).toBe(keys[0].slice(0, -4))
  })

  it('Pages のプレビューの host は noindex にする', () => {
    expect(read('_headers')).toMatch(/https:\/\/movie-ade\.pages\.dev\/\*\n\s+X-Robots-Tag: noindex/)
  })
})

describe('旧アドレス', () => {
  it('movie-ade.pages.dev（とプレビュー）で開かれたら、描画の前に ferretade.dev の同じページへ移す', () => {
    const js = read('js/theme.js')
    const re = new RegExp(/\/\(\^\|\\\.\)movie-ade\\\.pages\\\.dev\$\//.source)
    expect(js).toMatch(re)
    expect(js).toContain("location.replace('https://ferretade.dev' + location.pathname + location.search + location.hash)")
    // 移す先は SITE_URL と同じ
    expect(SITE_URL).toBe('https://ferretade.dev')
  })
})
