/**
 * フォルダの項目の読み方（src/main/dirEntries.ts）。Windows では opendir を使わない（FERRET-1Q：
 * Node 24.21.0 の DirHandle::DirHandle でのアクセス違反。公式のシンボルで ferret.exe+0x3b6c607 を読んで確かめた）
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDirEntries } from '../../src/main/dirEntries'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('readDirEntries', () => {
  it('どの読み方でも同じ項目を上限まで返し、打ち切ったかを知らせる', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ferret-dirents-'))
    dirs.push(root)
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
    mkdirSync(join(root, 'sub'))
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const all = await readDirEntries(root, 100, platform)
      expect(all.truncated).toBe(false)
      expect(all.entries.map((e) => e.name).sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'sub'])
      expect(all.entries.find((e) => e.name === 'sub')!.isDirectory()).toBe(true)
      const some = await readDirEntries(root, 3, platform)
      expect(some.entries).toHaveLength(3)
      expect(some.truncated).toBe(true)
    }
    await expect(readDirEntries(join(root, 'missing'), 10, 'win32')).rejects.toThrow()
  })

  it('配線：main で opendir を使うのは dirEntries.ts（Windows 以外）と Linux だけの見張り（linuxTreeWatch.ts）だけ', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [])
    const main = join(__dirname, '../../src/main')
    const users = walk(main).filter((f) => /\bopendir\(/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(main.length + 1).replace(/\\/g, '/')).sort()
    expect(users).toEqual(['dirEntries.ts', 'linuxTreeWatch.ts'])
  })
})
