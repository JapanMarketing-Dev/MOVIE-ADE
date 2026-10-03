import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deletableSessionDir, deleteSession, readLabel, sanitizeLabel, updateLabel } from '../../src/main/sessions/labels'
import { reviewsRoot, sessionPaths } from '../../src/main/sessions/paths'

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ade-labels-'))
  dirs.push(dir)
  return dir
}

describe('レビューを消すときのパスの検査', () => {
  it('reviews の直下の日時フォルダだけを返す', () => {
    // 返すのは絶対パス（Windows ではドライブ名が付く）
    expect(deletableSessionDir('/proj', '20261003-101500')).toBe(resolve(reviewsRoot('/proj'), '20261003-101500'))
  })

  it('日時の形でない ID・抜け出す ID は通さない', () => {
    for (const id of ['..', '../x', '20261003-101500/..', '/etc', '20261003-101500/../../a', '', 'abc', '2026100-101500', '20261003-101500 ']) {
      expect(() => deletableSessionDir('/proj', id), id).toThrow()
    }
  })

  it('フォルダごと消す。無ければ何もしない。他のレビューは残る', async () => {
    const root = await project()
    const keep = sessionPaths(root, '20261003-090000')
    const gone = sessionPaths(root, '20261003-100000')
    await mkdir(keep.dir, { recursive: true })
    await mkdir(join(gone.dir, 'work/frames'), { recursive: true })
    await writeFile(join(gone.dir, 'feedback.md'), '# x')
    await deleteSession(root, gone.id)
    await deleteSession(root, '20261003-110000')
    expect(await readdir(reviewsRoot(root))).toEqual([keep.id])
  })
})

describe('名前・アーカイブ・送った時刻', () => {
  it('読めなければ空', async () => {
    const root = await project()
    expect(await readLabel(sessionPaths(root, '20261003-100000'))).toEqual({})
  })

  it('名前を付ける・外す、アーカイブする', async () => {
    const root = await project()
    const p = sessionPaths(root, '20261003-100000')
    await mkdir(p.dir, { recursive: true })
    expect(await updateLabel(p, { name: '  料金ページの確認  ' })).toEqual({ name: '料金ページの確認' })
    expect(await updateLabel(p, { archived: true })).toEqual({ name: '料金ページの確認', archived: true })
    expect(await updateLabel(p, { name: null, archived: false })).toEqual({})
    expect(await readLabel(p)).toEqual({})
  })

  it('壊れた値は捨てる', () => {
    expect(sanitizeLabel({ name: 3, archived: 'yes', sentAt: 'not a date' })).toEqual({})
    expect(sanitizeLabel({ name: 'x'.repeat(500) }).name).toHaveLength(120)
    expect(sanitizeLabel({ sentAt: '2026-10-03T01:00:00.000Z' })).toEqual({ sentAt: '2026-10-03T01:00:00.000Z' })
  })
})
