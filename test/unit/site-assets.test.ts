import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_IMPORTS, SITE_DIR, assetVersion } from '../../tools/docs/asset-version.mjs'

/**
 * サイトの CSS / JS への参照は ?v=<中身の sha256 の先頭8文字> を持つ。
 * ゾーンの Browser Cache TTL が _headers より長いキャッシュを強いるので、中身が変わったら URL も変える。
 * ずれたら pnpm site:hash（site:meta でも走る）と pnpm docs:build。
 */
const pages = [
  ...readdirSync(SITE_DIR).filter((f) => f.endsWith('.html')),
  ...readdirSync(join(SITE_DIR, 'docs')).filter((f) => f.endsWith('.html')).map((f) => `docs/${f}`),
]

describe.each(pages)('%s', (page) => {
  const html = readFileSync(join(SITE_DIR, page), 'utf8')
  it('CSS / JS の参照がすべて今の版を持つ', () => {
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+\.(?:css|js)(?:\?[^"]*)?)"/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:|^\/\//i.test(u))
    expect(refs.length).toBeGreaterThan(0)
    const wrong = refs.filter((ref) => {
      const [path, query] = ref.split('?')
      const rel = path.startsWith('/') ? path.slice(1) : posix.normalize(posix.join(posix.dirname(page), path))
      return query !== `v=${assetVersion(rel)}`
    })
    expect(wrong).toEqual([])
  })

  it('ファビコンの参照も今の版を持つ（版が無いと、ブラウザが改名前のファビコンを1日覚えたままになる）', () => {
    const refs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*\shref="([^"]+)"/g)].map((m) => m[1]!)
    const wrong = refs.filter((ref) => {
      const [path, query] = ref.split('?')
      const rel = posix.normalize(posix.join(posix.dirname(page), path!))
      return query !== `v=${assetVersion(rel)}`
    })
    expect(wrong).toEqual([])
  })
})

describe('JS モジュールの import', () => {
  it.each(MODULE_IMPORTS)('%s の import が今の版を持つ', (file, deps) => {
    const src = readFileSync(join(SITE_DIR, file), 'utf8')
    for (const dep of deps) expect(src).toContain(`from './${dep}?v=${assetVersion(join(relative(SITE_DIR, join(SITE_DIR, dirname(file))), dep))}'`)
  })
})
