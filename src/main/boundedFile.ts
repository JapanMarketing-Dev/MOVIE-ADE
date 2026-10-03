/**
 * プロジェクト側のファイル（利用者以外が中身を決められる）を、上限のバイト数までしか読まない読み手（CWE-400）。
 *
 * readFile は大きさを見ずに全部をメモリへ載せる。疎なファイル（中身の無い巨大なファイル）や、
 * 名前付きパイプ（開くと止まる）・デバイスでも読みに行くので、main が止まる・落ちることがある。
 * - 開く前に普通のファイルであることを確かめる（パイプ・デバイス・フォルダは開かない）
 * - 大きさが上限を超えていれば、読む前に断る（疎なファイルも大きさで止まる）
 * - 読んでいる間に伸びても、上限を超えた時点でやめる
 */
import { constants, fstatSync, lstatSync, openSync, closeSync, readSync, statSync } from 'node:fs'
import { lstat, open, stat } from 'node:fs/promises'

/** ファイルが上限より大きい */
export class FileTooLargeError extends Error {
  constructor(readonly path: string, readonly limitBytes: number, readonly sizeBytes?: number) {
    super(`file is larger than ${limitBytes} bytes: ${path}`)
    this.name = 'FileTooLargeError'
  }
}

/** 普通のファイルでない（リンク・パイプ・デバイス・フォルダ） */
export class NotRegularFileError extends Error {
  constructor(readonly path: string) {
    super(`not a regular file: ${path}`)
    this.name = 'NotRegularFileError'
  }
}

export interface BoundedReadOptions {
  /** 末端がリンクなら断る（O_NOFOLLOW のある OS では開くときにも断る） */
  noFollow?: boolean
}

const flagsFor = (options: BoundedReadOptions) =>
  constants.O_RDONLY
  | (options.noFollow ? ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) : 0)
  // 確かめたあとにパイプへ差し替えられても、開くところで止まらない（普通のファイルには効かない）
  | ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0)

/** 上限までのバイト列を読む。上限を超える・普通のファイルでなければ投げる。無ければ ENOENT のまま投げる */
export async function readFileBounded(path: string, maxBytes: number, options: BoundedReadOptions = {}): Promise<Buffer> {
  const before = options.noFollow ? await lstat(path) : await stat(path)
  if (!before.isFile()) throw new NotRegularFileError(path)
  if (before.size > maxBytes) throw new FileTooLargeError(path, maxBytes, before.size)
  const handle = await open(path, flagsFor(options))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new NotRegularFileError(path)
    if (info.size > maxBytes) throw new FileTooLargeError(path, maxBytes, info.size)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      // 上限＋1バイトまで読めば、超えたかどうかが分かる
      const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new FileTooLargeError(path, maxBytes)
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

/** 上限までの文字列（UTF-8）を読む */
export async function readTextBounded(path: string, maxBytes: number, options: BoundedReadOptions = {}): Promise<string> {
  return (await readFileBounded(path, maxBytes, options)).toString('utf8')
}

/** 同期版（設定の読み込みなど、同期の呼び出し元のため） */
export function readTextBoundedSync(path: string, maxBytes: number, options: BoundedReadOptions = {}): string {
  const before = options.noFollow ? lstatSync(path) : statSync(path)
  if (!before.isFile()) throw new NotRegularFileError(path)
  if (before.size > maxBytes) throw new FileTooLargeError(path, maxBytes, before.size)
  const fd = openSync(path, flagsFor(options))
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new NotRegularFileError(path)
    if (info.size > maxBytes) throw new FileTooLargeError(path, maxBytes, info.size)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1 - total))
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new FileTooLargeError(path, maxBytes)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
