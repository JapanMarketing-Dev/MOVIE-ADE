import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { appendFileNoFollow, isWithin, pathChain, UnsafeStoragePathError, writeFileNoFollow } from '../../src/main/sessions/containment'
import { appendEvents, clearWork, createSession, deleteSession, ensureGitExclude, listSessions, pruneRecordings, saveSession, sessionPaths, updateLabel,
  writeFeedbackMarkdown } from '../../src/main/sessions/index'
import { takePaths } from '../../src/main/sessions/paths'
import type { SessionRecord } from '../../src/main/sessions/store'

/** 名前の上の判定（純粋関数）。win32 はファイルを作らずに path.win32 で確かめる */
describe('保存先の名前の上の判定', () => {
  it('posix: 下にあるか・外へ出るか', () => {
    expect(isWithin('/p', '/p/.ferret/reviews/x', path.posix)).toBe(true)
    expect(isWithin('/p', '/p', path.posix)).toBe(true)
    expect(isWithin('/p', '/p/../q', path.posix)).toBe(false)
    expect(isWithin('/p', '/pq/x', path.posix)).toBe(false)
    expect(isWithin('/p', '/p/..x', path.posix)).toBe(true)
    expect(pathChain('/p', '/p/a/b', path.posix)).toEqual(['/p/a', '/p/a/b'])
    expect(pathChain('/p', '/q', path.posix)).toBeNull()
  })

  it('win32: ドライブ・大文字小文字・UNC を見分ける', () => {
    const w = path.win32
    expect(isWithin('C:\\Proj', 'c:\\proj\\.ferret\\reviews', w)).toBe(true)
    expect(isWithin('C:\\Proj', 'D:\\Proj\\.ferret', w)).toBe(false)
    expect(isWithin('C:\\Proj', 'C:\\Proj2\\x', w)).toBe(false)
    expect(isWithin('\\\\server\\share\\proj', '\\\\server\\share\\proj\\a', w)).toBe(true)
    expect(isWithin('\\\\server\\share\\proj', '\\\\other\\share\\proj\\a', w)).toBe(false)
    expect(pathChain('C:\\Proj', 'C:\\Proj\\.ferret\\reviews', w)).toEqual(['C:\\Proj\\.ferret', 'C:\\Proj\\.ferret\\reviews'])
  })
})

let base = ''
let project = ''
let outside = ''
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ferret-contain-'))
  project = join(base, 'project')
  outside = join(base, 'outside')
  await mkdir(project)
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'secret')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const record = (id: string): SessionRecord => ({
  version: 1, meta: { id, startedAt: '2026-10-02T10:40:12Z', durationMs: 1000, twoSpeakers: false }, transcript: [], removedDuplicates: [], frames: [], draft: [],
  document: { meta: { id, startedAt: '2026-10-02T10:40:12Z', durationMs: 1000, twoSpeakers: false }, items: [], dropped: [], organizedByLlm: false }, edits: []
})
const outsideNames = async () => (await readdir(outside)).sort()
const ID = '20261002-104012'

describe('リンクをたどってプロジェクトの外へ書かない・消さない', () => {
  it('.ferret がリンクなら、レビューを作らない', async () => {
    await symlink(outside, join(project, '.ferret'), 'dir')
    await expect(createSession(project)).rejects.toBeInstanceOf(UnsafeStoragePathError)
    expect(await outsideNames()).toEqual(['keep.txt'])
  })

  it('reviews がリンクなら、レビューを作らない', async () => {
    await mkdir(join(project, '.ferret'))
    await symlink(outside, join(project, '.ferret', 'reviews'), 'dir')
    await expect(createSession(project)).rejects.toBeInstanceOf(UnsafeStoragePathError)
    expect(await outsideNames()).toEqual(['keep.txt'])
  })

  it('レビューのフォルダがリンクなら、パスを作らず・一覧に出さず・消さず・掃除しない', async () => {
    await mkdir(join(project, '.ferret', 'reviews'), { recursive: true })
    await writeFile(join(outside, 'session.json'), JSON.stringify(record(ID)))
    await writeFile(join(outside, 'recording.webm'), 'video')
    await symlink(outside, join(project, '.ferret', 'reviews', ID), 'dir')
    expect(() => sessionPaths(project, ID)).toThrow(UnsafeStoragePathError)
    expect(await listSessions(project)).toEqual([])
    await expect(deleteSession(project, ID)).rejects.toThrow()
    await pruneRecordings(project, { keepDays: 1, now: new Date(Date.now() + 30 * 86_400_000) })
    expect(await outsideNames()).toEqual(['keep.txt', 'recording.webm', 'session.json'])
  })

  it('feedback.md・label.json・session.json がリンクなら、たどらずに置き換える（外のファイルはそのまま）', async () => {
    const paths = await createSession(project)
    for (const leaf of [paths.feedbackMd, paths.labelJson, paths.sessionJson]) await symlink(join(outside, 'keep.txt'), leaf)
    await writeFeedbackMarkdown(paths, '# feedback')
    await updateLabel(paths, { name: 'x' })
    await saveSession(paths, record(paths.id))
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('secret')
    for (const leaf of [paths.feedbackMd, paths.labelJson, paths.sessionJson]) expect(lstatSync(leaf).isSymbolicLink()).toBe(false)
    expect(await readFile(paths.feedbackMd, 'utf8')).toBe('# feedback')
  })

  it('events.jsonl がリンク・ハードリンクなら追記しない', async () => {
    const paths = await createSession(project)
    await symlink(join(outside, 'keep.txt'), paths.eventsJsonl)
    await expect(appendEvents(paths, [{ t: 1, type: 'scroll', y: 1 }])).rejects.toThrow()
    await rm(paths.eventsJsonl)
    await link(join(outside, 'keep.txt'), paths.eventsJsonl)
    await expect(appendEvents(paths, [{ t: 1, type: 'scroll', y: 1 }])).rejects.toBeInstanceOf(UnsafeStoragePathError)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('secret')
  })

  it('録画・work がリンクなら、保存期間の掃除はリンクだけを消し、たどった先は消さない', async () => {
    const paths = await createSession(project)
    await saveSession(paths, record(paths.id))
    await mkdir(join(outside, 'work'))
    await writeFile(join(outside, 'work', 'a.png'), 'frame')
    await writeFile(join(outside, 'video.webm'), 'video')
    await rm(paths.workDir, { recursive: true })
    await symlink(join(outside, 'work'), paths.workDir, 'dir')
    await symlink(join(outside, 'video.webm'), paths.recording)
    const old = new Date(Date.now() - 30 * 86_400_000)
    await utimes(join(outside, 'video.webm'), old, old)
    await pruneRecordings(project, { keepDays: 7 })
    await clearWork(paths)
    expect(await readFile(join(outside, 'work', 'a.png'), 'utf8')).toBe('frame')
    expect(await readFile(join(outside, 'video.webm'), 'utf8')).toBe('video')
  })

  it('レビューを消すときも、中のリンクの先は消さない', async () => {
    const paths = await createSession(project)
    await symlink(outside, join(paths.dir, 'escape'), 'dir')
    await deleteSession(project, paths.id)
    expect(existsSync(paths.dir)).toBe(false)
    expect(await outsideNames()).toEqual(['keep.txt'])
  })

  it('追記の録画のフォルダ（takes）がリンクなら、パスを作らない', async () => {
    const paths = await createSession(project)
    await symlink(outside, join(paths.dir, 'takes'), 'dir')
    expect(() => takePaths(paths, 2)).toThrow(UnsafeStoragePathError)
  })

  it('末端を書く部品は、先回りのリンク・ハードリンクへ書き込まない', async () => {
    const file = join(project, 'a.txt')
    await symlink(join(outside, 'keep.txt'), file)
    await writeFileNoFollow(file, 'new')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('secret')
    await rm(file)
    await link(join(outside, 'keep.txt'), file)
    await expect(appendFileNoFollow(file, 'x')).rejects.toBeInstanceOf(UnsafeStoragePathError)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('secret')
  })
})

describe('.git の間接参照で除外ファイルの書く先を変えさせない', () => {
  const initRepo = (dir: string) => execFileSync('git', ['init', '-q', dir])

  it('gitdir: が別のリポジトリの .git を指していれば書かない（絶対パス・相対パス）', async () => {
    initRepo(join(outside, 'victim'))
    const victimExclude = join(outside, 'victim', '.git', 'info', 'exclude')
    const before = await readFile(victimExclude, 'utf8').catch(() => null)
    for (const value of [join(outside, 'victim', '.git'), path.relative(project, join(outside, 'victim', '.git'))]) {
      await writeFile(join(project, '.git'), `gitdir: ${value}\n`)
      expect(await ensureGitExclude(project)).toBe('no-git')
      expect(await readFile(victimExclude, 'utf8').catch(() => null)).toBe(before)
    }
  })

  it('info・exclude がリンクなら書かない', async () => {
    initRepo(project)
    await rm(join(project, '.git', 'info'), { recursive: true, force: true })
    await symlink(outside, join(project, '.git', 'info'), 'dir')
    expect(await ensureGitExclude(project)).toBe('no-git')
    expect(await outsideNames()).toEqual(['keep.txt'])

    await rm(join(project, '.git', 'info'))
    await mkdir(join(project, '.git', 'info'))
    await symlink(join(outside, 'keep.txt'), join(project, '.git', 'info', 'exclude'))
    expect(await ensureGitExclude(project)).toBe('no-git')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('secret')
  })

  it('.git 自体がリンクなら書かない', async () => {
    initRepo(join(outside, 'repo'))
    await symlink(join(outside, 'repo', '.git'), join(project, '.git'), 'dir')
    expect(await ensureGitExclude(project)).toBe('no-git')
    expect(await readFile(join(outside, 'repo', '.git', 'info', 'exclude'), 'utf8')).not.toContain('.ferret/')
  })

  it('普通のリポジトリには今までどおり書く', async () => {
    initRepo(project)
    expect(await ensureGitExclude(project)).toBe('added')
    expect(await readFile(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.ferret/')
  })
})
