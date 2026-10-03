import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasBinaryExtension, isBinaryBuffer, shouldIncludePath } from '@shared/files'
import { rankQuickOpenFiles } from '@shared/quickOpen'
import { listDirectory, listFiles, readTextFile, relativeInside, resolveInside, searchFiles, writeTextFile } from '../../src/main/files'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

describe('relativeInside（文字の上での内外判定）', () => {
  it('中のパスは相対パスを返す', () => {
    expect(relativeInside('/p/app', '/p/app')).toBe('')
    expect(relativeInside('/p/app', '/p/app/src/a.ts')).toBe('src/a.ts')
    expect(relativeInside('/p/app', '/p/app/src/../b.ts')).toBe('b.ts')
  })

  it('外へ出るパスは null', () => {
    expect(relativeInside('/p/app', '/p')).toBeNull()
    expect(relativeInside('/p/app', '/p/app/../other/a.ts')).toBeNull()
    // 名前の前方一致（/p/app2）を中と取り違えない
    expect(relativeInside('/p/app', '/p/app2/a.ts')).toBeNull()
  })

  it('`..name` は外ではない', () => {
    expect(relativeInside('/p/app', '/p/app/..name')).toBe('..name')
  })
})

describe('resolveInside（シンボリックリンクを含む検査）', () => {
  let base: string
  let root: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'ade-files-'))
    root = join(base, 'project')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(base, 'secret.txt'), 'secret')
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'b.txt'), 'b')
    // 外を指すリンク（ファイルとフォルダ）と、中を指すリンク
    await symlink(join(base, 'secret.txt'), join(root, 'leak.txt'))
    await symlink(join(base, 'outside'), join(root, 'leakdir'))
    await symlink(join(root, 'src', 'a.ts'), join(root, 'alias.ts'))
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('中のファイルは通す', async () => {
    await expect(resolveInside(root, 'src/a.ts')).resolves.toBe(join(root, 'src', 'a.ts'))
    await expect(resolveInside(root, 'alias.ts')).resolves.toBe(join(root, 'alias.ts'))
  })

  it('`..` で外へ出るパスは断る', async () => {
    await expect(resolveInside(root, '../secret.txt')).rejects.toThrow('プロジェクトフォルダの外')
    await expect(resolveInside(root, 'src/../../secret.txt')).rejects.toThrow('プロジェクトフォルダの外')
  })

  it('絶対パス・NUL は断る', async () => {
    await expect(resolveInside(root, join(base, 'secret.txt'))).rejects.toThrow('プロジェクトフォルダの外')
    await expect(resolveInside(root, 'src/a.ts\0')).rejects.toThrow('プロジェクトフォルダの外')
  })

  it('外を指すシンボリックリンクは、読むのも書くのも断る', async () => {
    await expect(readTextFile(root, 'leak.txt')).rejects.toThrow('プロジェクトフォルダの外')
    await expect(readTextFile(root, 'leakdir/b.txt')).rejects.toThrow('プロジェクトフォルダの外')
    await expect(writeTextFile(root, 'leakdir/new.txt', 'x')).rejects.toThrow('プロジェクトフォルダの外')
  })

  it('一覧には外を指すリンクを出さない', async () => {
    const names = (await listDirectory(root, '')).map((e) => e.name)
    expect(names).toContain('src')
    expect(names).toContain('alias.ts')
    expect(names).not.toContain('leak.txt')
    expect(names).not.toContain('leakdir')
  })

  it('中の新しいファイルは書ける', async () => {
    await writeTextFile(root, 'src/new.md', '# hi\n')
    const read = await readTextFile(root, 'src/new.md')
    expect(read).toMatchObject({ kind: 'text', content: '# hi\n', path: 'src/new.md' })
  })

  it('ファイル一覧と名前の検索は node_modules を含めない', async () => {
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'x', 'jp.js'), '')
    await writeFile(join(root, 'src', 'jp.ts'), '')
    const { files } = await listFiles(root)
    expect(files).toContain('src/a.ts')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    const names = await searchFiles(root, 'jp', 'names')
    expect(names.files).toEqual(['src/jp.ts'])
  })

  it('バイナリは開かずに理由を返す', async () => {
    await writeFile(join(root, 'data.dat'), Buffer.from([0x47, 0x00, 0x01, 0x02]))
    const read = await readTextFile(root, 'data.dat')
    expect(read.kind).toBe('binary')
  })
})

describe('バイナリの判定', () => {
  it('先頭 8KB に NUL があればバイナリ', () => {
    expect(isBinaryBuffer(new TextEncoder().encode('こんにちは\nconst a = 1'))).toBe(false)
    expect(isBinaryBuffer(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true)
    expect(isBinaryBuffer(new Uint8Array())).toBe(false)
  })

  it('8KB より後ろの NUL は見ない', () => {
    const buffer = new Uint8Array(9000).fill(0x61)
    buffer[8500] = 0
    expect(isBinaryBuffer(buffer)).toBe(false)
  })

  it('拡張子で分かるものは中身を読まずに断れる', () => {
    expect(hasBinaryExtension('.ade-movie/reviews/x/recording.mp4')).toBe(true)
    expect(hasBinaryExtension('assets/Logo.PNG')).toBe(true)
    expect(hasBinaryExtension('src/a.ts')).toBe(false)
    expect(hasBinaryExtension('icon.svg')).toBe(false)
    // ドットで始まるだけの名前は拡張子ではない
    expect(hasBinaryExtension('.zip')).toBe(false)
  })
})

describe('クイックオープンの絞り込み', () => {
  const files = [
    'src/renderer/App.tsx',
    'src/renderer/components/CenterTabs.tsx',
    'src/main/index.ts',
    'src/shared/ipc.ts',
    'package.json',
    'README.md'
  ]

  it('空の問い合わせなら先頭から並べる', () => {
    expect(rankQuickOpenFiles('', files, 3).map((r) => r.path)).toEqual(files.slice(0, 3))
  })

  it('文字を順に拾うあいまい一致で絞る', () => {
    const paths = rankQuickOpenFiles('ctabs', files).map((r) => r.path)
    expect(paths).toEqual(['src/renderer/components/CenterTabs.tsx'])
  })

  it('ファイル名にそのまま含むものを上に出す', () => {
    const paths = rankQuickOpenFiles('index', files).map((r) => r.path)
    expect(paths[0]).toBe('src/main/index.ts')
  })

  it('大文字小文字と区切り（\\）は区別しない', () => {
    expect(rankQuickOpenFiles('SRC\\SHARED', files)[0]?.path).toBe('src/shared/ipc.ts')
  })

  it('一致しなければ空', () => {
    expect(rankQuickOpenFiles('zzz', files)).toEqual([])
  })

  it('件数の上限を守る', () => {
    expect(rankQuickOpenFiles('s', files, 2)).toHaveLength(2)
  })
})

describe('一覧から外すディレクトリ', () => {
  it('.git・node_modules・録画の置き場所の下は外す', () => {
    expect(shouldIncludePath('src/a.ts')).toBe(true)
    expect(shouldIncludePath('.github/workflows/ci.yml')).toBe(true)
    expect(shouldIncludePath('.git/config')).toBe(false)
    expect(shouldIncludePath('packages/x/node_modules/y/index.js')).toBe(false)
    expect(shouldIncludePath('.ade-movie/reviews/1/review.json')).toBe(false)
  })
})
