/**
 * レビューの保存先（`.ferret/reviews/<日時>/` の中）が、プロジェクトの外へ向かないようにする（CWE-59）。
 *
 * プロジェクトのフォルダは利用者以外（取ってきたリポジトリ・展開した zip）が中身を決められる。
 * `.ferret`・`reviews`・レビューのフォルダ・`takes`・`work` などがシンボリックリンクやジャンクションだと、
 * 名前の上では中にあっても、書き込みや rm -r が外のファイルに届いてしまう。そこで:
 * - パスを作るとき（sessionPaths / takePaths）に、プロジェクトから先の今ある階層をたどり、
 *   リンク・ジャンクションがあれば断る。実体（realpath）がプロジェクトの実体の外でも断る（他の reparse point も含む）
 * - 末端のファイルは、たどらない形で書く（一時ファイルを排他で作って rename で置き換える。追記は O_NOFOLLOW）
 * - 書く・消すときは、親フォルダを開いて持ったまま pinnedDir.ts を通す（security-5 [11]。確かめてから書くまでに
 *   途中のフォルダをリンクへ差し替えられても外へ書かない・外を消さない）。ここで fs の変更の関数を直接呼ばない
 *
 * プロジェクトのフォルダ自体がリンクなのはかまわない（利用者が選んだ場所。実体を基準にする）。
 */
import { lstatSync, realpathSync } from 'node:fs'
import { lstat, type FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { readFileBounded } from '../boundedFile'
import { OutsideProjectError, PinnedDir, createFileIn, mkdirIn, openAppendIn, removeIn, renameIn } from '../pinnedDir'
import { ADE_DIR, LEGACY_ADE_DIR } from './paths'

/** レビューの保存先のファイルを読むときの上限（session.json などの JSON・JSONL。長い録画でも数十 MB に収まる） */
const MAX_STORAGE_FILE_BYTES = 64 * 1024 * 1024

export class UnsafeStoragePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeStoragePathError'
  }
}

/** child が parent と同じか、その下にあるか（名前の上だけで判定する純粋関数。win32 は大文字小文字を区別しない） */
export function isWithin(parent: string, child: string, p: path.PlatformPath = path): boolean {
  const rel = p.relative(p.resolve(parent), p.resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))
}

/** root から target までの各階層（root 自体は含まず、target を含む）。target が root の下に無ければ null */
export function pathChain(root: string, target: string, p: path.PlatformPath = path): string[] | null {
  if (!isWithin(root, target, p)) return null
  const rel = p.relative(p.resolve(root), p.resolve(target))
  if (!rel) return []
  const out: string[] = []
  let at = p.resolve(root)
  for (const part of rel.split(p.sep)) {
    at = p.join(at, part)
    out.push(at)
  }
  return out
}

/**
 * root から target までの今ある階層に、リンク・ジャンクションが無く、実体が root の実体の中にあることを確かめる。
 * まだ無い階層から先は確かめない（作るときに、確かめた親の下へ作る）。root が無ければ何もしない
 */
export function assertContained(root: string, target: string): void {
  const chain = pathChain(root, target)
  if (!chain) throw new UnsafeStoragePathError(`storage path is outside the project: ${target}`)
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch {
    return // 開いていないフォルダ（テストの仮のパスなど）。たどる先も無い
  }
  for (const at of chain) {
    let st
    try {
      st = lstatSync(at)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw err
    }
    // Windows のジャンクションも Node ではシンボリックリンクとして見える
    if (st.isSymbolicLink()) throw new UnsafeStoragePathError(`storage path contains a link: ${at}`)
    // ほかの reparse point（マウントポイントなど）は実体の場所で見分ける
    if (!isWithin(realRoot, realpathSync.native(at))) throw new UnsafeStoragePathError(`storage path resolves outside the project: ${at}`)
  }
}

/** 末端がリンク・フォルダ・ハードリンクなら断る（無ければ通す） */
async function assertPlainLeaf(file: string): Promise<void> {
  const st = await lstat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
  if (!st) return
  if (st.isSymbolicLink() || !st.isFile()) throw new UnsafeStoragePathError(`not a regular file: ${file}`)
  if (st.nlink > 1) throw new UnsafeStoragePathError(`file has other hard links: ${file}`)
}

/**
 * 読む。末端がリンク（とフォルダ・パイプ）なら断る（外のファイルの中身を画面・Agent へ渡さない）。
 * 大きさは maxBytes（既定 MAX_STORAGE_FILE_BYTES）まで。超えれば FileTooLargeError（プロジェクト側が巨大なファイルを置ける）。
 * 無ければ ENOENT のまま投げる（呼び出し側が「無い」として扱う）
 */
export async function readFileNoFollow(file: string, encoding?: 'utf8', options?: { maxBytes?: number }): Promise<string>
export async function readFileNoFollow(file: string, encoding: null, options?: { maxBytes?: number }): Promise<Buffer>
export async function readFileNoFollow(file: string, encoding: 'utf8' | null = 'utf8', options: { maxBytes?: number } = {}): Promise<string | Buffer> {
  const st = await lstat(file)
  if (st.isSymbolicLink() || !st.isFile()) throw new UnsafeStoragePathError(`not a regular file: ${file}`)
  const bytes = await readFileBounded(file, options.maxBytes ?? MAX_STORAGE_FILE_BYTES, { noFollow: true })
  return encoding ? bytes.toString('utf8') : bytes
}

/**
 * file を含むプロジェクトのフォルダ（目印のフォルダの手前）。目印は保存先のフォルダ（paths.ts の ADE_DIR・改名前の LEGACY_ADE_DIR）と、除外の設定の .git。
 * 目印が無ければ null（親フォルダの実体だけを持って確かめる）
 */
export function storageRootOf(file: string): string | null {
  const markers = [ADE_DIR, LEGACY_ADE_DIR, '.git']
  const parts = path.resolve(file).split(path.sep)
  for (let i = parts.length - 2; i > 0; i--) if (markers.includes(parts[i])) return parts.slice(0, i).join(path.sep) || path.sep
  return null
}

/** file の親フォルダを開いて持つ（プロジェクトが分かれば、その中であることも確かめる） */
async function pinParent(file: string, root?: string): Promise<PinnedDir> {
  const dir = path.dirname(file)
  try {
    return await PinnedDir.open(root ?? storageRootOf(file) ?? dir, dir)
  } catch (err) {
    if (err instanceof OutsideProjectError) throw new UnsafeStoragePathError(`storage path resolves outside the project: ${dir}`)
    throw err
  }
}

/** 開いて持った親の中で行う。外への差し替えに気づいたら UnsafeStoragePathError */
async function inParent<T>(file: string, fn: (pin: PinnedDir, name: string) => Promise<T>, root?: string): Promise<T> {
  const pin = await pinParent(file, root)
  try {
    return await fn(pin, path.basename(file))
  } catch (err) {
    if (err instanceof OutsideProjectError) throw new UnsafeStoragePathError(`storage path changed while writing: ${file}`)
    throw err
  } finally {
    await pin.close()
  }
}

/**
 * ファイルを書く。末端がリンクでもたどらない（一時ファイルを排他で作り、rename でリンクごと置き換える）。
 * 途中で落ちても、元のファイルは書きかけにならない。親フォルダを開いて持ったまま書く（pinnedDir.ts）
 */
export async function writeFileNoFollow(file: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  await inParent(file, async (pin, name) => {
    const tmp = `${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    // O_EXCL は既にある名前（リンクを含む）なら失敗する
    const handle = await createFileIn(pin, tmp, options.mode ?? 0o666)
    try {
      try {
        await handle.writeFile(data)
      } finally {
        await handle.close()
      }
      await renameIn(pin, tmp, pin, name, { replace: true })
    } catch (err) {
      await removeIn(pin, tmp).catch(() => undefined)
      throw err
    }
  })
}

/**
 * まだ無いファイルを作って開く（既にある名前・リンクには書かない。EEXIST）。親フォルダを開いて持ったまま作る（pinnedDir.ts）。
 * 録画の静止画・音声の区切り・削った動画など、新しい名前で書くもの
 */
export async function openNewFileContained(file: string, mode = 0o666): Promise<FileHandle> {
  return inParent(file, (pin, name) => createFileIn(pin, name, mode))
}

/** まだ無いファイルを作って書く（openNewFileContained） */
export async function writeNewFileContained(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await openNewFileContained(file)
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
}

/** 追記する。末端がリンク・ハードリンクなら断る（O_NOFOLLOW のある OS では開くときにも断る） */
export async function appendFileNoFollow(file: string, data: string): Promise<void> {
  await assertPlainLeaf(file)
  await inParent(file, async (pin, name) => {
    const handle = await openAppendIn(pin, name).catch((err: unknown) => {
      if (err instanceof OutsideProjectError) throw new UnsafeStoragePathError(`not a regular file: ${file}`)
      throw err
    })
    try {
      await handle.write(data)
    } finally {
      await handle.close()
    }
  })
}

/**
 * root（省略時は保存先の目印から決める）の下にフォルダを作る。root から先の無い段を1つずつ、親を開いて持ったまま作る。
 * 既にあるフォルダ（リンク・外を指すものは断る）はそのまま使う。exclusive なら最後の段が既にあれば EEXIST
 */
export async function mkdirContained(dir: string, options: { root?: string; exclusive?: boolean } = {}): Promise<void> {
  const root = options.root ?? storageRootOf(dir) ?? path.dirname(dir)
  const chain = pathChain(root, dir)
  if (!chain) throw new UnsafeStoragePathError(`storage path is outside the project: ${dir}`)
  for (const [i, at] of chain.entries()) {
    const last = i === chain.length - 1
    try {
      await inParent(at, (pin, name) => mkdirIn(pin, name), root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || (last && options.exclusive)) throw err
      // 既にある段は、リンク・ジャンクションでなく中を指すフォルダのときだけ使う
      assertContained(root, at)
      if (!(await lstat(at)).isDirectory()) throw new UnsafeStoragePathError(`not a folder: ${at}`)
    }
  }
}

/**
 * root（省略時は保存先の目印から決める）の下で from を to へ動かす。両方の親を開いて持ったまま動かす。
 * replace なら to にあるものを置き換える（無ければ、上書きせずに EEXIST）
 */
export async function renameContained(from: string, to: string, options: { root?: string; replace?: boolean } = {}): Promise<void> {
  const root = options.root ?? storageRootOf(from) ?? path.dirname(from)
  await inParent(from, (source, fromName) => inParent(to, (target, toName) =>
    renameIn(source, fromName, target, toName, { replace: options.replace === true }), root), root)
}

/**
 * root の下の target を消す（rm -r を含む）。消す前に、先祖にリンクが無く実体が root の中にあることを確かめ、
 * 親フォルダを開いて持ったまま消す（フォルダは隔離用の名前へ動かしてから中を消す。pinnedDir.ts）。
 * target 自体がリンクなら、リンクだけを消す（たどった先は消さない）
 */
export async function removeContained(root: string, target: string, options: { recursive?: boolean } = {}): Promise<void> {
  assertContained(root, path.dirname(target))
  const st = await lstat(target).catch(() => null)
  if (!st) return
  if (!st.isSymbolicLink()) assertContained(root, target)
  await inParent(target, (pin, name) => removeIn(pin, name, { recursive: options.recursive === true }), root)
}
