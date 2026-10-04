/**
 * プロジェクトの中のファイルを「開いたもの」に結び付けて確かめる（security-4 [5]）。
 *
 * resolveInside（files.ts）は、その時点の realpath がプロジェクトの中かを確かめて文字列を返す。
 * そのあとでパスを開き直すと、確かめてから開くまでのあいだにプロジェクトの中のプロセス（Agent など）が
 * 途中のフォルダや末端をシンボリックリンクに差し替え、外のファイルを開かせられる（TOCTOU）。
 * Node には openat が無いので、開いたあとで確かめる:
 *   1. パスを開く（書き込みでも O_TRUNC はしない。確かめる前に中身を変えない）
 *   2. 開いた fd の (dev, ino) と、いまのパスの realpath（プロジェクトの中であること）の (dev, ino) を比べる
 *   3. 違えば閉じて断る。書き込みは確かめたあとに fd に対して truncate・write する
 * 差し替えたままなら 2 の realpath が外になり、戻していれば fd の実体と食い違うので、どちらでも断る。
 * 新しいファイルは、確かめた親フォルダの実体の下に O_EXCL で作り、作ったあとで同じように確かめる。
 */
import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { t } from '@shared/i18n'
import { isWithin } from './sessions/containment'

const O_NONBLOCK = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

function outside(): Error {
  return new Error(t('files.errors.outside'))
}

/** いまの realpath がプロジェクトの実体の中なら、その実体のパス。外なら例外。無ければ ENOENT のまま */
export async function assertStillInside(root: string, absolute: string): Promise<string> {
  const [realRoot, real] = await Promise.all([realpath(root), realpath(absolute)])
  if (!isWithin(realRoot, real)) throw outside()
  return real
}

/** 開いた fd が、いまのパスが指すプロジェクトの中の実体と同じか。違えば例外 */
export async function assertHandleInside(handle: FileHandle, root: string, absolute: string): Promise<void> {
  const opened = await handle.stat({ bigint: true })
  let now
  try {
    now = await stat(await assertStillInside(root, absolute), { bigint: true })
  } catch (err) {
    // 開いたあとで消された・外へ向けられた
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw outside()
    throw err
  }
  if (opened.dev !== now.dev || opened.ino !== now.ino) throw outside()
}

/**
 * resolveInside を通ったパスを開き、開いたものがプロジェクトの中の実体かを確かめた FileHandle を返す。
 * 'write' は O_TRUNC しないので、中身を差し替えるときは確かめたあとに truncate(0) する。
 * 無ければ ENOENT のまま投げる
 */
export async function openContained(root: string, absolute: string, mode: 'read' | 'write'): Promise<FileHandle> {
  const flags = (mode === 'read' ? constants.O_RDONLY : constants.O_WRONLY) | O_NONBLOCK
  const handle = await open(absolute, flags)
  try {
    await assertHandleInside(handle, root, absolute)
    return handle
  } catch (err) {
    await handle.close()
    throw err
  }
}

/**
 * まだ無いファイルを作って開く。親フォルダの実体がプロジェクトの中かを確かめ、その実体の下に O_EXCL で作る
 * （既にあれば EEXIST。リンクの先には作らない）。作ったあとで開いたものを確かめる
 */
export async function createContained(root: string, absolute: string): Promise<FileHandle> {
  const parent = await assertStillInside(root, dirname(absolute))
  const target = join(parent, basename(absolute))
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o666)
  try {
    await assertHandleInside(handle, root, target)
    return handle
  } catch (err) {
    await handle.close()
    throw err
  }
}
