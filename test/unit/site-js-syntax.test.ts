import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * サイトの JS（site/js/*.js、site/docs/docs.js）は、ビルドを通さずにそのまま配信する。
 * 構文の誤り（行末のカンマの抜けなど）があると、そのページのボタンや表示がすべて動かなくなるので、node --check で確かめる。
 * app.js は DOM を使うので単体テストから import できず、ここ以外では読まれない（84a8570 でカンマが抜けたまま commit された）。
 */
const root = join(__dirname, '../..')
const files = [
  ...readdirSync(join(root, 'site/js')).filter((f) => f.endsWith('.js')).map((f) => `site/js/${f}`),
  'site/docs/docs.js',
]

describe('サイトの JS の構文', () => {
  it('検査するファイルがある', () => {
    expect(files).toEqual(expect.arrayContaining(['site/js/app.js', 'site/js/releases.js', 'site/docs/docs.js']))
  })

  it.each(files)('%s は ES モジュールとして構文が正しい', (file) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(join(root, file), 'utf8'), encoding: 'utf8' })
    expect(r.stderr, file).toBe('')
    expect(r.status, file).toBe(0)
  })
})
