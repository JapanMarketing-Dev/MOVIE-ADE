import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTooLargeError, NotRegularFileError, readFileBounded } from '../../src/main/boundedFile'
import { createSession, deleteSession, loadSession, pruneRecordings, readEvents, saveSession, sessionPaths, updateLabel, updateProgress,
  writeFeedbackMarkdown, listSessions } from '../../src/main/sessions/index'
import { takePaths } from '../../src/main/sessions/paths'
import { maxOf, readJsonLines, SESSION_LIMITS, sessionRecordProblem } from '../../src/main/sessions/limits'
import { UnsafeStoragePathError } from '../../src/main/sessions/containment'
import type { SessionRecord } from '../../src/main/sessions/store'
import { readTextFile, writeTextFile } from '../../src/main/files'

// review.ts は Electron を使う。単体テストでは差し替える（プレビューの画像は electron-vite の読み込みを持たない preview/image.ts を直接呼ぶ）
vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'ferret-security2-unit'), getLocale: () => 'en' },
  clipboard: {}, shell: {}, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

const POSIX = process.platform !== 'win32'
const ID = '20261002-104012'

let base = ''
let project = ''
let outside = ''
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ferret-sec2-'))
  project = join(base, 'project')
  outside = join(base, 'outside')
  await mkdir(project)
  await mkdir(outside)
  await writeFile(join(outside, 'target.txt'), 'victim')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const meta = { id: ID, startedAt: '2026-10-02T10:40:12Z', durationMs: 1000, twoSpeakers: false }
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1, meta, transcript: [], removedDuplicates: [], frames: [], draft: [],
  document: { meta, items: [], dropped: [], organizedByLlm: false }, edits: [], ...over
})
const item = (id: string, images: string[] = []) => ({ id, index: 1, t: 10, title: 'x', request: 'y', status: 'decided' as const, quotes: [], images,
  frameTimes: images.map(() => 10), contextTime: 10, context: {}, draftIds: [], annotationIds: [], include: true })
const victim = () => readFile(join(outside, 'target.txt'), 'utf8')

describe.runIf(POSIX)('security-2 [1] プロジェクト側のリンクで、レビューの出力・書き込みが外へ向かない', () => {
  it('security-2 [1] リンクにした .ferret / reviews / レビューのフォルダには、録画のフォルダを作らない・読まない', async () => {
    await symlink(outside, join(project, '.ferret'), 'dir')
    await expect(createSession(project)).rejects.toBeInstanceOf(UnsafeStoragePathError)
    await rm(join(project, '.ferret'))
    await mkdir(join(project, '.ferret'))
    await symlink(outside, join(project, '.ferret', 'reviews'), 'dir')
    await expect(createSession(project)).rejects.toBeInstanceOf(UnsafeStoragePathError)
    await rm(join(project, '.ferret', 'reviews'))
    await mkdir(join(project, '.ferret', 'reviews'))
    await symlink(outside, join(project, '.ferret', 'reviews', ID), 'dir')
    expect(() => sessionPaths(project, ID)).toThrow(UnsafeStoragePathError)
    expect(await listSessions(project)).toEqual([])
    expect(existsSync(join(outside, 'work'))).toBe(false)
  })

  it('security-2 [1] 先回りした feedback.md・label.json・progress.json のリンクとハードリンクは、たどらずに置き換える', async () => {
    const paths = await createSession(project)
    await saveSession(paths, record({ document: { meta, items: [item('i1')], dropped: [], organizedByLlm: false } }))
    await symlink(join(outside, 'target.txt'), paths.feedbackMd)
    await symlink(join(outside, 'target.txt'), paths.labelJson)
    await link(join(outside, 'target.txt'), paths.progressJson)
    await writeFeedbackMarkdown(paths, '# attacker-influenced')
    await updateLabel(paths, { name: 'renamed' })
    await updateProgress(paths, { i1: 'done' })
    expect(await victim()).toBe('victim')
    for (const leaf of [paths.feedbackMd, paths.labelJson]) expect(lstatSync(leaf).isSymbolicLink()).toBe(false)
  })

  it('security-2 [1] 決まった名前の *.tmp を先回りのリンクにしても、保存は外へ書かない', async () => {
    const paths = await createSession(project)
    for (const name of ['session.json.tmp', 'progress.json.tmp', 'summary.json.tmp', 'feedback.md.tmp']) await symlink(join(outside, 'target.txt'), join(paths.dir, name))
    await saveSession(paths, record({ document: { meta, items: [item('i1')], dropped: [], organizedByLlm: false } }))
    await updateProgress(paths, { i1: 'done' })
    await writeFeedbackMarkdown(paths, '# x')
    expect(await victim()).toBe('victim')
  })

  it('security-2 [1] 追記の録画のフォルダ（takes）・録画・work がリンクなら、作らず・掃除と削除はリンクの先に触れない', async () => {
    const paths = await createSession(project)
    await saveSession(paths, record())
    await symlink(outside, join(paths.dir, 'takes'), 'dir')
    expect(() => takePaths(paths, 2)).toThrow(UnsafeStoragePathError)
    await rm(paths.workDir, { recursive: true })
    await symlink(outside, paths.workDir, 'dir')
    await symlink(join(outside, 'target.txt'), paths.recording)
    await pruneRecordings(project, { keepDays: 1, now: new Date(Date.now() + 30 * 86_400_000) })
    await deleteSession(project, paths.id)
    expect(existsSync(paths.dir)).toBe(false)
    expect(await victim()).toBe('victim')
  })
})

describe('security-2 [5] プレビューの画像を上限なく読まない', () => {

  it.each(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'])('security-2 [5] 上限を超える疎なファイル（%s）は、全部を読まずに 413', async (ext) => {
    const { readPreviewImage, previewImageType, PREVIEW_IMAGE_MAX_BYTES } = await import('../../src/main/preview/image')
    const file = join(project, `huge${ext}`)
    await writeFile(file, '')
    await truncate(file, PREVIEW_IMAGE_MAX_BYTES + 1)
    expect(previewImageType(`huge${ext}`)).toBeTruthy()
    expect((await readPreviewImage(project, `huge${ext}`)).status).toBe(413)
  })

  it('security-2 [5] 上限ちょうどまでの画像は返す', async () => {
    const { readPreviewImage } = await import('../../src/main/preview/image')
    await writeFile(join(project, 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const res = await readPreviewImage(project, 'ok.png')
    expect(res.status).toBe(200)
    expect(res.status === 200 && res.body.length).toBe(4)
  })

  it.runIf(POSIX)('security-2 [5] 普通のファイルでない画像（名前付きパイプ・フォルダ）と外を指すリンクは開かずに 404', async () => {
    const { readPreviewImage } = await import('../../src/main/preview/image')
    execFileSync('mkfifo', [join(project, 'pipe.png')])
    await mkdir(join(project, 'dir.png'))
    await symlink(join(outside, 'target.txt'), join(project, 'outside.png'))
    expect((await readPreviewImage(project, 'pipe.png')).status).toBe(404)
    expect((await readPreviewImage(project, 'dir.png')).status).toBe(404)
    expect((await readPreviewImage(project, 'outside.png')).status).toBe(404)
  })

  it.runIf(POSIX)('security-2 [5] 同じ種類: エディタのテキストの読み書きも、パイプで止まらず、疎な巨大ファイルを読まない', async () => {
    execFileSync('mkfifo', [join(project, 'pipe.md')])
    await expect(readTextFile(project, 'pipe.md')).rejects.toThrow()
    // 保存も、名前付きパイプへは書かずに断る（main が止まらない）。新しいファイルは作れる
    await expect(writeTextFile(project, 'pipe.md', 'x')).rejects.toThrow()
    await writeTextFile(project, 'new.md', 'hello')
    expect(await readFile(join(project, 'new.md'), 'utf8')).toBe('hello')
    await writeFile(join(project, 'huge.md'), '')
    await truncate(join(project, 'huge.md'), 64 * 1024 * 1024)
    expect((await readTextFile(project, 'huge.md')).kind).toBe('tooLarge')
  })

  it('security-2 [5] 保存先が普通のファイルでなければ書かない', async () => {
    // フォルダ（どの OS でも作れる）と、POSIX では名前付きパイプ（開いて書くと main が止まっていた）
    await mkdir(join(project, 'folder.md'))
    await expect(writeTextFile(project, 'folder.md', 'x')).rejects.toThrow()
    if (POSIX) {
      execFileSync('mkfifo', [join(project, 'pipe.txt')])
      await expect(writeTextFile(project, 'pipe.txt', 'x')).rejects.toThrow()
      expect(lstatSync(join(project, 'pipe.txt')).isFIFO()).toBe(true)
    }
    // 新しいファイルの作成と、普通のファイルの上書きは今までどおり
    await writeTextFile(project, 'created.md', 'first')
    await writeTextFile(project, 'created.md', 'second')
    expect(await readFile(join(project, 'created.md'), 'utf8')).toBe('second')
  })

  it('security-2 [5] 上限付きの読み手は、上限を超えた時点で断る', async () => {
    const file = join(project, 'a.bin')
    await writeFile(file, Buffer.alloc(11))
    await expect(readFileBounded(file, 10)).rejects.toBeInstanceOf(FileTooLargeError)
    expect((await readFileBounded(file, 11)).length).toBe(11)
    await expect(readFileBounded(project, 10)).rejects.toBeInstanceOf(NotRegularFileError)
  })
})

describe('security-2 [8] レビューの記録を上限なく解析しない', () => {
  async function writeSession(text: string | Buffer): Promise<ReturnType<typeof sessionPaths>> {
    const paths = sessionPaths(project, ID, '.ferret')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.sessionJson, text)
    return paths
  }

  it('security-2 [8] 上限を超える session.json（疎なファイル）は読まずに壊れた記録として扱う', async () => {
    const paths = await writeSession('')
    await truncate(paths.sessionJson, SESSION_LIMITS.sessionJsonBytes + 1)
    expect(await loadSession(paths)).toBeNull()
  })

  it('security-2 [8] 桁外れの件数・形の合わない session.json は、版が 1 でも受け付けない', async () => {
    const many = Array.from({ length: SESSION_LIMITS.items + 1 }, (_, i) => item(`i${i}`))
    expect(sessionRecordProblem(record({ document: { meta, items: many, dropped: [], organizedByLlm: false } }))).toMatch(/too many items/)
    expect(sessionRecordProblem({ version: 1, meta, transcript: 'x' })).not.toBeNull()
    expect(sessionRecordProblem(record({ document: { meta, items: [{ ...item('i1'), images: Array(100).fill('./01.png') }], dropped: [], organizedByLlm: false } }))).toMatch(/images/)
    expect(sessionRecordProblem(record({ frames: [{ t: 'x' } as never] }))).toBe('frames')
    const paths = await writeSession(JSON.stringify({ version: 1, meta, transcript: [], frames: [], edits: [], document: { items: [{ nested: [[[[[]]]]] }] } }))
    expect(await loadSession(paths)).toBeNull()
    // 普通の記録は今までどおり読める
    const ok = await writeSession(JSON.stringify(record({ document: { meta, items: [item('i1')], dropped: [], organizedByLlm: false } })))
    expect((await loadSession(ok))?.document.items).toHaveLength(1)
  })

  it('security-2 [8] JSONL は行数・1行の長さ・大きさに上限を置いて読む', async () => {
    const file = join(project, 'e.jsonl')
    const lines = [JSON.stringify({ t: 1, type: 'scroll', y: 0 }), JSON.stringify({ t: 2, type: 'scroll', y: 'x'.repeat(SESSION_LIMITS.jsonlLineBytes) }), '{"t": 3', JSON.stringify({ t: 4, type: 'scroll', y: 0 })]
    await writeFile(file, lines.join('\n'))
    expect((await readJsonLines<{ t: number }>(file)).map((e) => e.t)).toEqual([1, 4])
    expect(await readJsonLines(file, { maxLines: 1 })).toHaveLength(1)
    await writeFile(file, '')
    await truncate(file, SESSION_LIMITS.jsonlBytes + 1)
    expect(await readJsonLines(file)).toEqual([])
  })

  it('security-2 [8] 引数の上限を超える件数の復元でも、可変長引数を使わず落ちない', async () => {
    // V8 の可変長引数の上限（十数万）を超える数
    const values = Array.from({ length: 300_000 }, (_, i) => i)
    expect(maxOf(values, 0)).toBe(299_999)
    const paths = sessionPaths(project, ID, '.ferret')
    await mkdir(paths.dir, { recursive: true })
    const frames = Array.from({ length: 200_000 }, (_, i) => JSON.stringify({ t: i, path: `${i}.jpeg` })).join('\n')
    await writeFile(join(paths.dir, 'frames.jsonl'), frames)
    await writeFile(paths.eventsJsonl, JSON.stringify({ t: 0, type: 'nav', url: 'http://x/', title: '' }) + '\n')
    const { loadReviewAt } = await import('../../src/main/review')
    const review = await loadReviewAt(paths)
    expect(review.document.meta.durationMs).toBe(199_999)
  }, 60_000)

  it('security-2 [8] 画面へ渡す画像は、1枚の大きさと合計に上限を置く（巨大な PNG は base64 にしない）', async () => {
    const paths = sessionPaths(project, ID, '.ferret')
    await mkdir(paths.dir, { recursive: true })
    await saveSession(paths, record({ document: { meta, items: [item('i1', ['./01.png']), item('i2', ['./02.png'])], dropped: [], organizedByLlm: false } }))
    await writeFile(join(paths.dir, '01.png'), Buffer.from([1, 2, 3]))
    await writeFile(join(paths.dir, '02.png'), '')
    await truncate(join(paths.dir, '02.png'), SESSION_LIMITS.imageBytes + 1)
    const { loadReviewAt } = await import('../../src/main/review')
    const review = await loadReviewAt(paths)
    expect(Object.keys(review.images)).toEqual(['./01.png'])
  })

  it('security-2 [8] 操作ログの形の合わない行（t が数でない）は捨てる', async () => {
    const paths = sessionPaths(project, ID, '.ferret')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.eventsJsonl, ['{"t":"x","type":"click"}', 'null', '{"t":5,"type":"scroll","y":0}'].join('\n'))
    expect((await readEvents(paths)).map((e) => e.t)).toEqual([5])
  })
})
