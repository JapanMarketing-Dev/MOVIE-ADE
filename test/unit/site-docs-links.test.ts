import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS_DIR, renderDocs } from '../../tools/docs/build-docs.mjs'

// site/docs/ の静的 HTML が tools/docs/build-docs.mjs の出力と一致し、
// 内部リンク（href / src）が実在するファイルと見出しの id を指しているか確かめる
const SITE = resolve(__dirname, '../../site')

// 英語は site/docs/、ほかの言語は site/docs/<lang>/
const pages = readdirSync(DOCS_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.html')).map((f) => f.split('\\').join('/'))

function targetFile(from: string, path: string): string {
  const abs = resolve(dirname(from), path)
  return existsSync(abs) && statSync(abs).isDirectory() ? join(abs, 'index.html') : abs
}

function ids(file: string): Set<string> {
  return new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
}

describe('site/docs', () => {
  it('pnpm docs:build の出力と一致する', () => {
    const docs = renderDocs()
    expect(pages.sort()).toEqual(Object.keys(docs).sort())
    // .gitattributes で LF に揃えているが、手元の設定で CRLF になっていても改行の違いでは落とさない
    for (const [file, html] of Object.entries(docs)) expect(readFileSync(join(DOCS_DIR, file), 'utf8').replace(/\r\n/g, '\n'), file).toBe(html)
  })

  for (const page of pages) {
    it(`${page} のリンク先がある`, () => {
      const file = join(DOCS_DIR, page)
      const html = readFileSync(file, 'utf8')
      const broken: string[] = []
      for (const [, raw] of html.matchAll(/\s(?:href|src|content="0; url)="?([^"]*)"/g)) {
        if (/^(?:[a-z]+:|\/\/)/i.test(raw)) continue // 外部（https:, mailto: など）は見ない
        const [withQuery, hash] = raw.split('#')
        const path = withQuery.split('?')[0] // ?v=<版>（CSS / JS のキャッシュ破り）は外して見る
        const target = path ? targetFile(file, path) : file
        if (!target.startsWith(SITE) || !existsSync(target)) {
          broken.push(raw)
          continue
        }
        if (hash && target.endsWith('.html') && !ids(target).has(hash)) broken.push(raw)
      }
      expect(broken).toEqual([])
    })
  }
})
