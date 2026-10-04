/**
 * レビューの保存先（`.ferret/reviews/<日時>/` の中）が、プロジェクトの外へ向かないようにする（CWE-59）。
 *
 * プロジェクトのフォルダは利用者以外（取ってきたリポジトリ・展開した zip）が中身を決められる。
 * `.ferret`・`reviews`・レビューのフォルダ・`takes`・`work` などがシンボリックリンクやジャンクションだと、
 * 名前の上では中にあっても、書き込みや rm -r が外のファイルに届いてしまう。そこで:
 * - パスを作るとき（sessionPaths / takePaths）に、プロジェクトから先の今ある階層をたどり、
 *   リンク・ジャンクションがあれば断る。実体（realpath）がプロジェクトの実体の外でも断る（他の reparse point も含む）
 * - 末端のファイルは、たどらない形で書く（一時ファイルを排他で作って rename で置き換える。追記は O_NOFOLLOW）
 *
 * プロジェクトのフォルダ自体がリンクなのはかまわない（利用者が選んだ場所。実体を基準にする）。
 */
import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { readFileBounded } from '../boundedFile'

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
 * ファイルを書く。末端がリンクでもたどらない（一時ファイルを排他で作り、rename でリンクごと置き換える）。
 * 途中で落ちても、元のファイルは書きかけにならない
 */
export async function writeFileNoFollow(file: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  // 'wx' は既にある名前（リンクを含む）なら失敗する
  await writeFile(tmp, data, { flag: 'wx', ...(options.mode !== undefined ? { mode: options.mode } : {}) })
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** 追記する。末端がリンク・ハードリンクなら断る（O_NOFOLLOW のある OS では開くときにも断る） */
export async function appendFileNoFollow(file: string, data: string): Promise<void> {
  await assertPlainLeaf(file)
  const nofollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | nofollow, 0o644)
  try {
    await handle.write(data)
  } finally {
    await handle.close()
  }
}

/**
 * root の下の target を消す（rm -r を含む）。消す前に、先祖にリンクが無く実体が root の中にあることを確かめる。
 * target 自体がリンクなら、リンクだけを消す（たどった先は消さない）
 */
export async function removeContained(root: string, target: string, options: { recursive?: boolean } = {}): Promise<void> {
  assertContained(root, path.dirname(target))
  const st = await lstat(target).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink()) {
    await rm(target, { force: true })
    return
  }
  assertContained(root, target)
  await rm(target, { recursive: options.recursive === true, force: true })
}
