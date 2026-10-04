import { lstat, mkdir, realpath, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ENTRY_NAME_PROBLEM_KEYS, entryNameProblem, isInsideGitDir, type FsEntry } from '@shared/files'
import { t } from '@shared/i18n'
import { UserFacingError, toUserFacingFileError } from '@shared/errors'
import { relativeInside, resolveInside } from './files'
import { assertStillInside, createContained } from './containedFile'

/**
 * ファイルツリーからの作成・名前の変更・削除（fs:create / fs:rename / fs:trash）。
 *
 * renderer から来るのはプロジェクトからの相対パスと、1階層分の名前だけ。ここで必ず
 *   1. パスがプロジェクトの中か（resolveInside。`..`・絶対パス・外へ出るシンボリックリンクを断る）
 *   2. 名前が1階層分で、どの OS でも使えるか（entryNameProblem。区切り・制御文字・Windows の予約名など）
 *   3. .git の中ではないか（文字の上と、リンクを辿った実体の両方）
 * を確かめてから触る。既にある名前は上書きしない。削除はゴミ箱へ送る（元に戻せる）。
 */

/** 1回で削除できる数の上限（選択の誤りで大量に送らない） */
export const MAX_TRASH_ENTRIES = 1000

function assertName(name: unknown): asserts name is string {
  const problem = entryNameProblem(name as string)
  if (problem) throw new UserFacingError(t(ENTRY_NAME_PROBLEM_KEYS[problem]))
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** 中のパスへ直す。無ければ「見つからない」（OS の文言は絶対パスを含むので画面へ出さない） */
async function resolveExisting(root: string, relPath: unknown): Promise<{ absolute: string; rel: string }> {
  let absolute: string
  try {
    absolute = await resolveInside(root, relPath)
  } catch (err) {
    if (isMissing(err)) throw new UserFacingError(t('files.errors.notFound'))
    throw err
  }
  return { absolute, rel: relativeInside(root, absolute) ?? '' }
}

/** .git の中（.git そのものを含む）なら断る。リンクを辿った実体も見る */
async function assertOutsideGit(root: string, absolute: string, rel: string): Promise<void> {
  if (isInsideGitDir(rel)) throw new UserFacingError(t('files.errors.gitDir'))
  const real = relativeInside(await realpath(root), await realpath(absolute))
  if (real !== null && isInsideGitDir(real)) throw new UserFacingError(t('files.errors.gitDir'))
}

function existsError(name: string): UserFacingError {
  return new UserFacingError(t('files.errors.exists', { name }))
}

/** parentRel のフォルダに、空のファイルか空のフォルダを作る。作ったものの相対パスを返す */
export async function createEntry(root: string, parentRel: string, name: string, kind: FsEntry['kind']): Promise<string> {
  if (kind !== 'file' && kind !== 'directory') throw new UserFacingError(t('files.errors.badContent'))
  assertName(name)
  const parent = await resolveExisting(root, parentRel)
  await assertOutsideGit(root, parent.absolute, parent.rel)
  if (!(await stat(parent.absolute)).isDirectory()) throw new UserFacingError(t('files.errors.notFolder'))
  const target = join(parent.absolute, name)
  try {
    // O_EXCL・mkdir は既にあれば失敗する（確かめてから作るあいだに作られても上書きしない）。
    // ファイルは親の実体の下に作り、作ったものが中かを確かめる（containedFile.ts）。mkdir は安全な形が無いので直前に親を確かめ直す
    if (kind === 'file') await (await createContained(root, target)).close()
    else await mkdir(join(await assertStillInside(root, parent.absolute), name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw existsError(name)
    throw toUserFacingFileError(err)
  }
  return relativeInside(root, target) ?? ''
}

/** 同じフォルダの中で名前を変える。新しい相対パスを返す */
export async function renameEntry(root: string, relPath: string, newName: string): Promise<string> {
  assertName(newName)
  const source = await resolveExisting(root, relPath)
  if (source.rel === '') throw new UserFacingError(t('files.errors.projectRoot'))
  await assertOutsideGit(root, source.absolute, source.rel)
  const oldName = basename(source.absolute)
  const target = join(dirname(source.absolute), newName)
  if (oldName === newName) return source.rel
  const existing = await lstat(target).catch((err: unknown) => { if (isMissing(err)) return null; throw err })
  if (existing) {
    // 大文字小文字だけの変更は、大文字小文字を区別しないファイルシステムでは同じものが見える。それだけは通す
    const self = await lstat(source.absolute)
    const caseOnly = oldName.toLowerCase() === newName.toLowerCase() && existing.ino === self.ino && existing.dev === self.dev
    if (!caseOnly) throw existsError(newName)
  }
  // 確かめてから動かすまでに、元や親がリンクへ差し替えられて外を指していないか
  await assertStillInside(root, source.absolute)
  await assertStillInside(root, dirname(target))
  await rename(source.absolute, target).catch((err: unknown) => { throw toUserFacingFileError(err) })
  return relativeInside(root, target) ?? ''
}

/**
 * ゴミ箱へ送る（Electron の shell.trashItem を trash に渡す）。消した相対パスを返す。
 * 先に全部を確かめ、1つでも断るものがあれば何も消さない。選んだものの下にあるものは、親と一緒に送るので省く。
 */
export async function trashEntries(root: string, relPaths: unknown, trash: (absolute: string) => Promise<void>): Promise<string[]> {
  if (!Array.isArray(relPaths) || relPaths.length === 0 || relPaths.length > MAX_TRASH_ENTRIES) throw new UserFacingError(t('files.errors.badContent'))
  const targets: Array<{ absolute: string; rel: string }> = []
  for (const relPath of relPaths) {
    const target = await resolveExisting(root, relPath)
    if (target.rel === '') throw new UserFacingError(t('files.errors.projectRoot'))
    await assertOutsideGit(root, target.absolute, target.rel)
    targets.push(target)
  }
  const rels = new Set(targets.map((x) => x.rel))
  const top = targets.filter((x, i) =>
    targets.findIndex((y) => y.rel === x.rel) === i && ![...rels].some((other) => other !== x.rel && x.rel.startsWith(`${other}/`)))
  const trashed: string[] = []
  for (const target of top) {
    await assertStillInside(root, target.absolute)
    try {
      await trash(target.absolute)
    } catch {
      // OS の文言は絶対パスを含むことがあるので、名前だけを出す（ゴミ箱の無いドライブ・権限など）
      throw new UserFacingError(t('files.errors.trashFailed', { name: basename(target.absolute) }))
    }
    trashed.push(target.rel)
  }
  return trashed
}

/**
 * ゴミ箱へ送る口。ふだんは渡された trashItem（Electron の shell.trashItem）。
 * E2E（ADE_E2E=1）で ADE_E2E_TRASH_DIR があれば、使っている人の本物のゴミ箱を汚さないよう、そのフォルダへ移す。
 */
export function trashFor(trashItem: (absolute: string) => Promise<void>, env: NodeJS.ProcessEnv = process.env): (absolute: string) => Promise<void> {
  const dir = env.ADE_E2E === '1' ? env.ADE_E2E_TRASH_DIR?.trim() : ''
  if (!dir) return trashItem
  return async (absolute) => { await rename(absolute, join(dir, `${Date.now()}-${basename(absolute)}`)) }
}
