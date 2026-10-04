import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
// @ts-expect-error 型の無い .mjs のスクリプト
import { ALLOWED_TOP, MAX_BYTES, asarProblems } from '../../scripts/check-app-asar.mjs'

const require = createRequire(import.meta.url)
const config = require('../../electron-builder.config.cjs') as { files: string[]; win: { files?: string[] }; mac?: { files?: string[] }; linux?: { files?: string[] } }

/**
 * 配布物の app.asar に、入れてよいもの（out/・package.json・node_modules）だけが入る。
 * 0.4.6 の公開前に、win.files に除外だけを書いていたため全体の files が効かず、Windows 版へ作業フォルダが丸ごと入った
 * （Agent の作業ツリー・レビューの記録・.env を含む）。設定の形と、ビルドの最後の検査の両方で止める。
 */
describe('配布物に入れるもの', () => {
  it('OS ごとの files は、全体の files をすべて含む（除外だけを書かない）', () => {
    for (const os of ['win', 'mac', 'linux'] as const) {
      const files = config[os]?.files
      if (!files) continue
      for (const pattern of config.files) expect(files, `${os}.files に ${pattern} がありません`).toContain(pattern)
    }
    expect(config.files).toEqual(expect.arrayContaining(['out/**/*', 'package.json', 'node_modules/**/*', '!**/*.map', '!**/.env*']))
  })

  it('ビルドは app.asar を OS ごとに確かめ、作業ツリー・記録・キーを写さない', () => {
    const script = readFileSync('scripts/build-release.sh', 'utf8')
    expect(script).toMatch(/check-app-asar\.mjs dist\/release\/mac\*\/Ferret\.app\/Contents\/Resources\/app\.asar dist\/release\/win-unpacked\/resources\/app\.asar dist\/release\/win-arm64-unpacked\/resources\/app\.asar/)
    expect(script).toMatch(/check-app-asar\.mjs "\$\{WORK\}\/linux\/out\/linux-app\.asar"/)
    expect(script).toMatch(/\.claude\|\.ade-movie\|\.ferret\|\.env\|\.env\.\*\) continue/)
  })

  it('検査: 入れてよいものだけなら通り、作業フォルダ・記録・キー・ソースマップ・大きすぎは止める', () => {
    const good = { files: { out: { files: { 'main.js': { size: 1 } } }, 'package.json': { size: 1 }, node_modules: { files: {} } } }
    expect(asarProblems(good, 64 * 1048576)).toEqual([])
    expect([...ALLOWED_TOP].sort()).toEqual(['node_modules', 'out', 'package.json'])
    const bad = { files: { ...good.files, '.claude': { files: { worktrees: { files: { 'a.ts': { size: 1 } } } } }, '.ade-movie': { files: { 'r.webm': { size: 1 } } },
      '.env': { size: 1 }, out: { files: { 'main.js.map': { size: 1 } } } } }
    const problems = asarProblems(bad, MAX_BYTES + 1).join('\n')
    expect(problems).toMatch(/\.claude/)
    expect(problems).toMatch(/\.ade-movie/)
    expect(problems).toMatch(/\.env/)
    expect(problems).toMatch(/\.map/)
    expect(problems).toMatch(/大きすぎます/)
  })
})
