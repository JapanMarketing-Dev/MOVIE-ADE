import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, rename, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { ENTRY_NAME_PROBLEM_KEYS, MAX_COPY_BYTES, MAX_COPY_ENTRIES, entryNameProblem, isInsideGitDir, nestedNameParts, nestedNameProblem, uniqueName, type FsCreated, type FsEntry, type FsTransfer } from '@shared/files'
import { t } from '@shared/i18n'
import { UserFacingError, toUserFacingFileError } from '@shared/errors'
import { relativeInside, resolveInside } from './files'
import { assertStillInside, openContained } from './containedFile'
import { OutsideProjectError, createFileIn, entryIdentity, mkdirIn, removeIn, renameIn, symlinkIn, trashIn, withPinnedDir } from './pinnedDir'
import { isWithin } from './sessions/containment'
import { isRecentlyDropped } from './droppedPaths'
import { MAX_MARKDOWN_MEDIA_BYTES, MAX_MARKDOWN_MEDIA_FILES, MAX_MARKDOWN_MEDIA_TOTAL_BYTES, isMarkdownFilePath, markdownMediaKind, pickMediaFolder, safeMediaFileName, uniqueMediaName } from '@shared/markdownMedia'

const O_NONBLOCK = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

/**
 * ファイルツリーからの作成・名前の変更・削除（fs:create / fs:rename / fs:trash）。
 *
 * renderer から来るのはプロジェクトからの相対パスと、1階層分の名前だけ。ここで必ず
 *   1. パスがプロジェクトの中か（resolveInside。`..`・絶対パス・外へ出るシンボリックリンクを断る）
 *   2. 名前が1階層分で、どの OS でも使えるか（entryNameProblem。区切り・制御文字・Windows の予約名など）
 *   3. .git の中ではないか（文字の上と、リンクを辿った実体の両方）
 * を確かめてから触る。既にある名前は上書きしない。削除はゴミ箱へ送る（元に戻せる）。
 * 作る・名前を変える・動かす・消すは、すべて親フォルダを開いて持ったまま pinnedDir.ts を通す（security-5 [11]。
 * 確かめてから変えるまでに途中のフォルダをリンクへ差し替えられても、外を変えない）。ここで fs の変更の関数を直接呼ばない。
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

/**
 * parentRel のフォルダに、空のファイルか空のフォルダを作る。
 * 名前に「a/b/c.ts」のように `/` を含めれば、途中の無いフォルダも作る（あるフォルダはそのまま使う）。
 * 作ったものの相対パスと、今回新しくできたいちばん上の相対パスを返す
 */
export async function createEntry(root: string, parentRel: string, name: string, kind: FsEntry['kind']): Promise<FsCreated> {
  if (kind !== 'file' && kind !== 'directory') throw new UserFacingError(t('files.errors.badContent'))
  const problem = nestedNameProblem(name)
  if (problem) throw new UserFacingError(t(ENTRY_NAME_PROBLEM_KEYS[problem]))
  const parts = nestedNameParts(name)
  const parent = await resolveExisting(root, parentRel)
  await assertOutsideGit(root, parent.absolute, parent.rel)
  if (!(await stat(parent.absolute)).isDirectory()) throw new UserFacingError(t('files.errors.notFolder'))
  let dir = parent.absolute
  let top: string | null = null
  for (const part of parts.slice(0, -1)) {
    const next = join(dir, part)
    try {
      await withPinnedDir(root, dir, (pin) => mkdirIn(pin, part))
      top ??= next
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw toUserFacingFileError(err)
      // 途中にあるのがフォルダ（中を指すリンクを含む）ならそのまま使う。ファイルなら断る
      const existing = await stat(await assertStillInside(root, next))
      if (!existing.isDirectory()) throw new UserFacingError(t('files.errors.notFolder'))
      await assertOutsideGit(root, next, relativeInside(root, next) ?? '')
    }
    dir = next
  }
  const last = parts.at(-1)!
  const target = join(dir, last)
  try {
    // O_EXCL・mkdir は既にあれば失敗する（確かめてから作るあいだに作られても上書きしない）。
    // 親を開いて持ったまま作り、作ったものが中かを確かめる（pinnedDir.ts）
    await withPinnedDir(root, dir, async (pin) => {
      if (kind === 'file') await (await createFileIn(pin, last)).close()
      else await mkdirIn(pin, last)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw existsError(last)
    throw toUserFacingFileError(err)
  }
  return { path: relativeInside(root, target) ?? '', top: relativeInside(root, top ?? target) ?? '' }
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
  let caseOnly = false
  if (existing) {
    // 大文字小文字だけの変更は、大文字小文字を区別しないファイルシステムでは同じものが見える。それだけは通す
    const self = await lstat(source.absolute)
    caseOnly = oldName.toLowerCase() === newName.toLowerCase() && existing.ino === self.ino && existing.dev === self.dev
    if (!caseOnly) throw existsError(newName)
  }
  // 親を開いて持ったまま、上書きせずに動かす（確かめてから動かすまでに、親がリンクへ差し替えられても外を変えない）
  await withPinnedDir(root, dirname(source.absolute), (pin) => renameIn(pin, oldName, pin, newName, { replace: caseOnly })).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw existsError(newName)
    throw toUserFacingFileError(err)
  })
  return relativeInside(root, target) ?? ''
}

/**
 * ゴミ箱へ送る（Electron の shell.trashItem を trash に渡す）。消した相対パスを返す。
 * 先に全部を確かめ、1つでも断るものがあれば何も消さない。選んだものの下にあるものは、親と一緒に送るので省く。
 */
export async function trashEntries(root: string, relPaths: unknown, trash: (absolute: string) => Promise<void>): Promise<string[]> {
  if (!Array.isArray(relPaths) || relPaths.length === 0 || relPaths.length > MAX_TRASH_ENTRIES) throw new UserFacingError(t('files.errors.badContent'))
  const targets: Array<{ absolute: string; rel: string; id: { dev: bigint; ino: bigint } }> = []
  for (const relPath of relPaths) {
    const target = await resolveExisting(root, relPath)
    if (target.rel === '') throw new UserFacingError(t('files.errors.projectRoot'))
    await assertOutsideGit(root, target.absolute, target.rel)
    // 確かめたものの実体。送る直前に、同じ名前が同じ実体かを見る
    const id = await lstat(target.absolute, { bigint: true })
    targets.push({ ...target, id: { dev: id.dev, ino: id.ino } })
  }
  const rels = new Set(targets.map((x) => x.rel))
  const top = targets.filter((x, i) =>
    targets.findIndex((y) => y.rel === x.rel) === i && ![...rels].some((other) => other !== x.rel && x.rel.startsWith(`${other}/`)))
  const trashed: string[] = []
  for (const target of top) {
    try {
      await withPinnedDir(root, dirname(target.absolute), (pin) => trashIn(pin, basename(target.absolute), trash, target.id))
    } catch (err) {
      if (err instanceof OutsideProjectError) throw err
      // OS の文言は絶対パスを含むことがあるので、名前だけを出す（ゴミ箱の無いドライブ・権限など）
      throw new UserFacingError(t('files.errors.trashFailed', { name: basename(target.absolute) }))
    }
    trashed.push(target.rel)
  }
  return trashed
}

/** コピーで1回に読み書きする大きさ */
const COPY_CHUNK_BYTES = 1024 * 1024

/** 1回で移動・コピーに選べる数の上限（削除と同じ） */
export const MAX_TRANSFER_ENTRIES = MAX_TRASH_ENTRIES

function badRequest(): UserFacingError {
  return new UserFacingError(t('files.errors.badContent'))
}

function intoItselfError(): UserFacingError {
  return new UserFacingError(t('files.errors.intoItself'))
}

/** 移動・コピーの先のフォルダ。プロジェクトの中・.git の外・フォルダであること */
async function resolveDestination(root: string, destRel: unknown): Promise<{ absolute: string; rel: string }> {
  const dest = await resolveExisting(root, destRel)
  await assertOutsideGit(root, dest.absolute, dest.rel)
  if (!(await stat(dest.absolute)).isDirectory()) throw new UserFacingError(t('files.errors.notFolder'))
  return dest
}

/** 選んだもの（相対パス）を確かめ、重なり（親と一緒に選んだ子）を省く */
async function resolveSources(root: string, relPaths: unknown): Promise<Array<{ absolute: string; rel: string }>> {
  if (!Array.isArray(relPaths) || relPaths.length === 0 || relPaths.length > MAX_TRANSFER_ENTRIES) throw badRequest()
  const sources: Array<{ absolute: string; rel: string }> = []
  for (const relPath of relPaths) {
    const source = await resolveExisting(root, relPath)
    if (source.rel === '') throw new UserFacingError(t('files.errors.projectRoot'))
    await assertOutsideGit(root, source.absolute, source.rel)
    if (!sources.some((x) => x.rel === source.rel)) sources.push(source)
  }
  return sources.filter((x) => !sources.some((other) => other.rel !== x.rel && x.rel.startsWith(`${other.rel}/`)))
}

/** フォルダをそれ自身の中へ動かす・コピーするのは断る（リンクを辿った実体でも見る） */
async function assertNotIntoItself(source: string, dest: string): Promise<void> {
  const [realSource, realDest] = await Promise.all([realpath(source), realpath(dest)])
  if (isWithin(realSource, realDest)) throw intoItselfError()
}

/** 中身を数える（リンクは辿らない）。上限を超えたらその場で断る */
async function measure(absolute: string, total: { entries: number; bytes: number }): Promise<void> {
  const info = await lstat(absolute)
  total.entries++
  if (info.isFile()) total.bytes += info.size
  if (total.entries > MAX_COPY_ENTRIES) throw new UserFacingError(t('files.errors.copyTooMany', { limit: MAX_COPY_ENTRIES.toLocaleString('en-US') }))
  if (total.bytes > MAX_COPY_BYTES) throw new UserFacingError(t('files.errors.copyTooLarge', { limit: Math.round(MAX_COPY_BYTES / 1024 / 1024 / 1024) }))
  if (!info.isDirectory()) return
  for (const name of await readdir(absolute)) await measure(join(absolute, name), total)
}

/**
 * source（ファイルかフォルダ）を target へコピーする。target はまだ無い名前。
 * 書く側は毎回、親フォルダを開いて持ったまま作る（ファイルは O_EXCL・O_NOFOLLOW。pinnedDir.ts）。
 * 読む側は、プロジェクトの中なら開いたものが中の実体かを確かめ（openContained）、外から取り込むなら読むだけで開く。
 * リンクは辿らない: プロジェクトの中のコピーではリンクのまま写し、外からの取り込みでは写さない。パイプ・ソケットなどは写さない
 */
async function copyTree(root: string, source: string, target: string, origin: 'project' | 'external', onCreated: (id: { dev: bigint; ino: bigint }) => void = () => undefined): Promise<void> {
  const info = await lstat(source)
  const name = basename(target)
  /** 作ったものの実体（失敗したときに、作ったものだけを消すため） */
  const created = async (pin: Parameters<typeof entryIdentity>[0]) => { const id = await entryIdentity(pin, name); if (id) onCreated(id) }
  if (info.isSymbolicLink()) {
    if (origin === 'project') { const link = await readlink(source); await withPinnedDir(root, dirname(target), async (pin) => { await symlinkIn(pin, name, link); await created(pin) }) }
    return
  }
  if (info.isDirectory()) {
    if (origin === 'project') await assertStillInside(root, source)
    await withPinnedDir(root, dirname(target), async (pin) => { await mkdirIn(pin, name); await created(pin) })
    for (const child of await readdir(source)) await copyTree(root, join(source, child), join(target, child), origin)
    return
  }
  if (!info.isFile()) return
  const input = origin === 'project'
    ? await openContained(root, source, 'read')
    : await open(source, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    if (!(await input.stat()).isFile()) return
    const output = await withPinnedDir(root, dirname(target), async (pin) => { const handle = await createFileIn(pin, name); await created(pin); return handle })
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, null)).bytesWritten
      }
      await output.chmod(info.mode & 0o777).catch(() => undefined)
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}

/** コピーの途中で失敗したら、作りかけを消す（今回作ったものだけ。先に同じ名前が作られていたらそれは消さない） */
async function copyOrCleanUp(root: string, source: string, target: string, origin: 'project' | 'external'): Promise<void> {
  let created: { dev: bigint; ino: bigint } | null = null
  try {
    await copyTree(root, source, target, origin, (id) => { created = id })
  } catch (err) {
    // 作ったものと同じ実体のときだけ、親を開いて持ったまま消す
    const id = created
    if (id) await withPinnedDir(root, dirname(target), (pin) => removeIn(pin, basename(target), { recursive: true, expect: id })).catch(() => undefined)
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw existsError(basename(target))
    throw toUserFacingFileError(err)
  }
}

/** フォルダの中にある名前（重ならない名前を選ぶため） */
async function namesIn(root: string, dir: string): Promise<string[]> {
  return readdir(await assertStillInside(root, dir))
}

/**
 * 選んだもの（相対パス）を destRel のフォルダへコピーする（貼り付け・複製）。
 * 同じ名前があれば「名前 copy」「名前 copy 2」と重ならない名前にする（上書きはしない）。from → to の組を返す
 */
export async function copyEntries(root: string, relPaths: unknown, destRel: unknown): Promise<FsTransfer[]> {
  const dest = await resolveDestination(root, destRel)
  const sources = await resolveSources(root, relPaths)
  const total = { entries: 0, bytes: 0 }
  for (const source of sources) {
    await assertNotIntoItself(source.absolute, dest.absolute)
    await measure(source.absolute, total)
  }
  const taken = await namesIn(root, dest.absolute)
  const done: FsTransfer[] = []
  for (const source of sources) {
    const info = await lstat(source.absolute)
    const name = uniqueName(basename(source.absolute), info.isDirectory() ? 'directory' : 'file', taken)
    const target = join(dest.absolute, name)
    await copyOrCleanUp(root, source.absolute, target, 'project')
    taken.push(name)
    done.push({ from: source.rel, to: relativeInside(root, target) ?? '' })
  }
  return done
}

/**
 * 選んだもの（相対パス）を destRel のフォルダへ動かす（切り取り・貼り付け、ドラッグ）。名前は変えない。
 * 先に全部を確かめ、移動先に同じ名前があれば何も動かさずに断る（上書きはしない）。
 * もともとそのフォルダにあるものは動かさない（from と to が同じ組で返す）
 */
export async function moveEntries(root: string, relPaths: unknown, destRel: unknown): Promise<FsTransfer[]> {
  const dest = await resolveDestination(root, destRel)
  const sources = await resolveSources(root, relPaths)
  const taken = new Set((await namesIn(root, dest.absolute)).map((x) => x.toLowerCase()))
  const plan: Array<{ source: { absolute: string; rel: string }; target: string }> = []
  for (const source of sources) {
    await assertNotIntoItself(source.absolute, dest.absolute)
    const name = basename(source.absolute)
    const target = join(dest.absolute, name)
    if (dirname(source.absolute) === dest.absolute) { plan.push({ source, target: source.absolute }); continue }
    if (taken.has(name.toLowerCase())) throw existsError(name)
    taken.add(name.toLowerCase())
    plan.push({ source, target })
  }
  const done: FsTransfer[] = []
  for (const { source, target } of plan) {
    if (target !== source.absolute) {
      // 元の親と先のフォルダを開いて持ったまま、上書きせずに動かす（確かめてから動かすまでに差し替えられても外を変えない）
      await withPinnedDir(root, dirname(source.absolute), (from) => withPinnedDir(root, dest.absolute, (to) =>
        renameIn(from, basename(source.absolute), to, basename(target))))
        .catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw existsError(basename(target))
          throw toUserFacingFileError(err)
        })
    }
    done.push({ from: source.rel, to: relativeInside(root, target) ?? '' })
  }
  return done
}

/**
 * OS（Finder・エクスプローラー）から落としたファイルやフォルダを、destRel のフォルダへコピーして取り込む。
 * 元のパスは、最近ウインドウへ落とされて drop:inspect で確かめたものだけを受け付ける（droppedPaths.ts。renderer から任意のパスを読ませない）。
 * 確かめるのは取り込み先がプロジェクトの中であることと、上限。元のファイルは読むだけで、動かしも変えもしない。
 * 同じ名前があれば「名前 copy」にする。from は元の名前、to は新しい相対パス
 */
export async function importEntries(root: string, absolutePaths: unknown, destRel: unknown, wasDropped: (path: unknown) => boolean = isRecentlyDropped): Promise<FsTransfer[]> {
  if (!Array.isArray(absolutePaths) || absolutePaths.length === 0 || absolutePaths.length > MAX_TRANSFER_ENTRIES) throw badRequest()
  const dest = await resolveDestination(root, destRel)
  const sources: Array<{ absolute: string; kind: FsEntry['kind'] }> = []
  const total = { entries: 0, bytes: 0 }
  for (const source of absolutePaths) {
    if (typeof source !== 'string' || !isAbsolute(source) || source.includes('\0') || !wasDropped(source)) throw badRequest()
    const info = await lstat(source).catch((err: unknown) => { if (isMissing(err)) throw new UserFacingError(t('files.errors.notFound')); throw err })
    if (!info.isFile() && !info.isDirectory()) throw new UserFacingError(t('files.errors.cantImport', { name: basename(source) }))
    if (info.isDirectory()) await assertNotIntoItself(source, dest.absolute)
    await measure(source, total)
    sources.push({ absolute: source, kind: info.isDirectory() ? 'directory' : 'file' })
  }
  const taken = await namesIn(root, dest.absolute)
  const done: FsTransfer[] = []
  for (const source of sources) {
    const name = uniqueName(basename(source.absolute), source.kind, taken)
    const target = join(dest.absolute, name)
    await copyOrCleanUp(root, source.absolute, target, 'external')
    taken.push(name)
    done.push({ from: basename(source.absolute), to: relativeInside(root, target) ?? '' })
  }
  return done
}

/**
 * OS から Markdown のファイルへ落とした画像・動画を、その Markdown の隣のフォルダ（assets/ など。@shared/markdownMedia の
 * pickMediaFolder。無ければ作る）へコピーする。コピーしたものの相対パスを、渡した順に返す。
 * 元のパスは importEntries と同じく、最近落とされて drop:inspect で確かめたものだけ。埋め込める種類の普通のファイルだけを、
 * 種類ごとの大きさの上限までで受ける。名前は Markdown のリンクに書ける形にし、重なれば「名前-2」にする（上書きしない）。
 * 書き込みは親フォルダを開いて持ったまま（pinnedDir.ts）、プロジェクトの中・.git の外だけ
 */
export async function importMediaForMarkdown(root: string, markdownRel: unknown, absolutePaths: unknown, wasDropped: (path: unknown) => boolean = isRecentlyDropped): Promise<string[]> {
  if (!Array.isArray(absolutePaths) || absolutePaths.length === 0 || absolutePaths.length > MAX_MARKDOWN_MEDIA_FILES) throw badRequest()
  const markdown = await resolveExisting(root, markdownRel)
  if (markdown.rel === '' || !isMarkdownFilePath(markdown.rel)) throw badRequest()
  await assertOutsideGit(root, markdown.absolute, markdown.rel)
  if (!(await stat(markdown.absolute)).isFile()) throw badRequest()
  const sources: string[] = []
  let total = 0
  for (const source of absolutePaths) {
    if (typeof source !== 'string' || !isAbsolute(source) || source.includes('\0') || !wasDropped(source)) throw badRequest()
    const name = basename(source)
    const kind = markdownMediaKind(name)
    if (!kind) throw new UserFacingError(t('files.errors.notMedia', { name }))
    // リンク・パイプ・フォルダは受けない（lstat。リンクを辿らない）
    const info = await lstat(source).catch((err: unknown) => { if (isMissing(err)) throw new UserFacingError(t('files.errors.notFound')); throw err })
    if (!info.isFile()) throw new UserFacingError(t('files.errors.notMedia', { name }))
    const limit = MAX_MARKDOWN_MEDIA_BYTES[kind]
    if (info.size > limit) throw new UserFacingError(t('files.errors.mediaTooLarge', { name, limit: Math.round(limit / 1024 / 1024) }))
    total += info.size
    if (total > MAX_COPY_BYTES || total > MAX_MARKDOWN_MEDIA_TOTAL_BYTES) throw new UserFacingError(t('files.errors.copyTooLarge', { limit: Math.round(MAX_MARKDOWN_MEDIA_TOTAL_BYTES / 1024 / 1024 / 1024) }))
    sources.push(source)
  }
  // コピー先のフォルダ。Markdown の隣の assets / images / media / img のうち既にあるもの、無ければ作る
  const dir = dirname(markdown.absolute)
  const siblings = await readdir(await assertStillInside(root, dir), { withFileTypes: true })
  const folder = pickMediaFolder(siblings.filter((entry) => entry.isDirectory()).map((entry) => entry.name), siblings.map((entry) => entry.name))
  if (!folder) throw new UserFacingError(t('files.errors.notFolder'))
  const dest = join(dir, folder)
  await withPinnedDir(root, dir, (pin) => mkdirIn(pin, folder)).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw toUserFacingFileError(err)
  })
  const target = await resolveDestination(root, relativeInside(root, dest) ?? '')
  const taken = await namesIn(root, target.absolute)
  const done: string[] = []
  for (const source of sources) {
    const name = uniqueMediaName(safeMediaFileName(basename(source)), taken)
    const file = join(target.absolute, name)
    await copyOrCleanUp(root, source, file, 'external')
    taken.push(name)
    done.push(relativeInside(root, file) ?? '')
  }
  return done
}

/** パスをコピーする文字列。absolute は絶対パス、relative はプロジェクトからの相対パス（OS の区切り）。複数なら1行に1つ */
export async function pathsForClipboard(root: string, relPaths: unknown, kind: 'absolute' | 'relative'): Promise<string> {
  if (!Array.isArray(relPaths) || relPaths.length === 0 || relPaths.length > MAX_TRANSFER_ENTRIES) throw badRequest()
  const lines: string[] = []
  for (const relPath of relPaths) {
    const { absolute, rel } = await resolveExisting(root, relPath)
    lines.push(kind === 'absolute' ? absolute : rel === '' ? '.' : rel.split('/').join(sep))
  }
  return lines.join('\n')
}

/** 「ターミナルで開く」の作業フォルダ（絶対パス）。フォルダならそれ、ファイルならその親 */
export async function terminalDirFor(root: string, relPath: unknown): Promise<string> {
  const { absolute } = await resolveExisting(root, relPath)
  const real = await assertStillInside(root, absolute)
  return (await stat(real)).isDirectory() ? absolute : dirname(absolute)
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
