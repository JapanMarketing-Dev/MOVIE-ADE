import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOWNLOAD_BASE, REPO_URL, SITE_URL } from '../../site/js/config.js'

/** ダウンロードサイトの静的な約束ごと（絶対 URL・言語・配信設定） */

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')
const attr = (html: string, re: RegExp) => re.exec(html)?.[1]

describe.each([
  ['site/index.html', '/'],
  ['site/download.html', '/download']
])('%s', (file, path) => {
  const html = read(file)

  it('og:image・og:url・canonical は config.js の SITE_URL から作った絶対 URL（ずれたら pnpm site:meta）', () => {
    expect(attr(html, /<meta property="og:image" content="([^"]*)"/)).toMatch(new RegExp(`^${SITE_URL.replace(/[.]/g, '\\.')}/assets/og\\.png\\?v=[0-9a-f]{8}$`))
    expect(attr(html, /<meta property="og:url" content="([^"]*)"/)).toBe(`${SITE_URL}${path}`)
    expect(attr(html, /<link rel="canonical" href="([^"]*)"/)).toBe(`${SITE_URL}${path}`)
  })

  it('SNS のカード: og.png の寸法・代替テキストと、og:title・og:description と同じ twitter:*（ずれたら pnpm site:meta）', () => {
    expect(attr(html, /<meta property="og:image:width" content="([^"]*)"/)).toBe('1200')
    expect(attr(html, /<meta property="og:image:height" content="([^"]*)"/)).toBe('630')
    expect(attr(html, /<meta property="og:image:alt" content="([^"]+)"/)).toBeTruthy()
    expect(attr(html, /<meta name="twitter:card" content="([^"]*)"/)).toBe('summary_large_image')
    expect(attr(html, /<meta name="twitter:title" content="([^"]*)"/)).toBe(attr(html, /<meta property="og:title" content="([^"]*)"/))
    expect(attr(html, /<meta name="twitter:description" content="([^"]*)"/)).toBe(attr(html, /<meta property="og:description" content="([^"]*)"/))
    expect(attr(html, /<meta name="twitter:image" content="([^"]*)"/)).toMatch(new RegExp(`^${SITE_URL.replace(/[.]/g, '\\.')}/assets/og\\.png\\?v=[0-9a-f]{8}$`))
    // og.png の実寸がメタの寸法と合う（PNG の IHDR）
    const png = readFileSync(resolve(__dirname, '../..', 'site/assets/og.png'))
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
  })

  it('英語のページで、日本語の文字を含まない（コメントを除く）', () => {
    expect(html).toContain('<html lang="en">')
    expect(html.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/[぀-ヿ一-鿿]/)
  })

  it('CSP に合わせ、インラインの script を持たない', () => {
    expect(html).not.toMatch(/<script>(?!<\/script>)/)
    expect(html).toMatch(/<script src="js\/theme\.js(\?v=[0-9a-f]{8})?"><\/script>/)
  })

  it('提供元と GitHub へのリンクがある', () => {
    expect(html).toMatch(/Built by <a href="https:\/\/www\.japan-marketing\.co\.jp\/"[^>]*>Japan Marketing LLC/)
    expect(html).toContain(`href="${REPO_URL}"`)
  })
})

describe('配信の設定', () => {
  it('wrangler.jsonc は Cloudflare Pages の出力に site/ を指す', () => {
    const json = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''))
    expect(json).toMatchObject({ name: 'movie-ade', pages_build_output_dir: './site' })
  })

  it('_headers の connect-src は配布元（R2）と Cloudflare Web Analytics だけを許す', () => {
    const headers = read('site/_headers')
    expect(headers).toContain(`connect-src 'self' ${DOWNLOAD_BASE} https://cloudflareinsights.com;`)
    expect(headers).toContain("script-src 'self' https://static.cloudflareinsights.com;")
  })

  it('GitHub Pages 向けの名残が無い', () => {
    expect(read('site/404.html')).not.toContain('/MOVIE-ADE/')
    expect(() => read('site/.nojekyll')).toThrow()
  })
})
