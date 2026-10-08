/**
 * ターミナルにクリップボードの画像・動画を直接渡す（⌘V / Ctrl+V）。
 * main がプロジェクトの .ferret/pasted/ に写し、作ったものの絶対パスだけを返す（クリップボードの中身・元のパスは返さない。security-7 [1]）
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const { pasteClipboardForTerminal, TERMINAL_PASTE_DIR } = await import('../../src/main/clipboardFiles')
const { hasClipboardFiles } = await import('../../src/renderer/terminal/clipboardPaste')

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
const tempRoot = async () => { const d = await realpath(await mkdtemp(join(tmpdir(), 'ferret-tpaste-'))); dirs.push(d); return d }

describe('クリップボードのファイル・画像をターミナルへ', () => {
  it('スクリーンショット（画像）は .ferret/pasted/ に PNG で置き、その絶対パスを返す', async () => {
    const root = await tempRoot()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const paths = await pasteClipboardForTerminal(root, { read: async () => [{ types: ['image/png'], getType: async () => new Blob([png]) }] }, async () => [])
    expect(paths).toHaveLength(1)
    expect(paths![0]!.startsWith(join(root, '.ferret', 'pasted', 'pasted-'))).toBe(true)
    expect(paths![0]!.endsWith('.png')).toBe(true)
    expect(await readFile(paths![0]!)).toEqual(png)
  })

  it('Finder でコピーした動画などは、写した先のパスだけを返す（元のパスは返さない）', async () => {
    const root = await tempRoot()
    const asked: Array<{ paths: string[]; dest: string }> = []
    const paths = await pasteClipboardForTerminal(root,
      { read: async () => [{ types: ['electron application/osclipboard;format="NSFilenamesPboardType"'], getType: async () => new Blob(['<string>/Users/taro/Desktop/demo.mov</string>']) }] },
      async (src, dest) => { asked.push({ paths: src, dest }); await writeFile(join(root, dest, 'demo.mov'), 'mov'); return [`${dest}/demo.mov`] })
    expect(asked).toEqual([{ paths: ['/Users/taro/Desktop/demo.mov'], dest: TERMINAL_PASTE_DIR }])
    expect(paths).toEqual([join(root, '.ferret', 'pasted', 'demo.mov')])
    expect(paths!.join()).not.toContain('/Users/taro')
  })

  it('文字だけなら null（ふつうの貼り付け）', async () => {
    const root = await tempRoot()
    expect(await pasteClipboardForTerminal(root, { read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['hello']) }] }, async () => [])).toBeNull()
  })

  it('画面側：ファイル・画像があるときだけ横取りする（文字だけの貼り付けはそのまま）', () => {
    expect(hasClipboardFiles({ types: ['text/plain', 'Files'] })).toBe(true)
    expect(hasClipboardFiles({ types: ['image/png'] })).toBe(true)
    expect(hasClipboardFiles({ types: ['text/plain', 'text/html'] })).toBe(false)
    expect(hasClipboardFiles(null)).toBe(false)
  })

  it('配線：押した直後の1回だけ（Ctrl+V の OS の貼り付けからは1回の許可）、SSH では写さない', () => {
    const main = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    expect(main).toMatch(/'terminal:pasteFiles': async \(\) => \{[\s\S]{0,400}!\(granted \|\| gestures\.consume\('paste'\)\)\) return null[\s\S]{0,200}isRemoteWorkspace\(\)\) return null/)
    expect(main).toMatch(/terminalPasteGrantAt = Date\.now\(\)\n\s+win\.webContents\.paste\(\)/)
    expect(readFileSync(join(__dirname, '../../src/shared/ipc.ts'), 'utf8')).toContain("'terminal:pasteFiles': () => string[] | null")
  })
})
