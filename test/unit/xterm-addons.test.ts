import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * xterm の addon は xterm 本体の major ごとに別の 0.x の版になる。合わない組み合わせは描画はできても dispose などで落ちる
 * （2026-10-04、Dependabot の addon-webgl 0.19 / addon-fit 0.11 を xterm 5.5 に入れ、タブを閉じるたびに FERRET-1J）。
 * 版を上げるときは、この表と xterm 本体を一緒に上げる。
 */
const COMPATIBLE: Record<number, Record<string, string>> = {
  5: { '@xterm/addon-fit': '0.10.', '@xterm/addon-webgl': '0.18.', '@xterm/addon-canvas': '0.7.' }
}

const root = resolve(__dirname, '../..')
const installed = (name: string): string =>
  (JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version

describe('xterm の addon の版', () => {
  it('入っている addon が xterm 本体の major に合う版である', () => {
    const major = Number(installed('@xterm/xterm').split('.')[0])
    const table = COMPATIBLE[major]
    expect(table, `xterm ${major} 用の addon の表がありません`).toBeDefined()
    for (const [name, prefix] of Object.entries(table!)) {
      expect(installed(name), name).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    }
  })

  it('package.json は addon を固定の版で書く（^ で次の xterm 用の版に上がらない）', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const name of ['@xterm/addon-fit', '@xterm/addon-webgl']) expect(deps[name], name).toMatch(/^\d/)
  })
})
