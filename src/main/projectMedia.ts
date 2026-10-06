/**
 * エディタで文字として開けないファイル（画像・動画・音声・PDF・その他のバイナリ）の中身を返す。
 *
 * - ade-media://project/<相対パス> … 画像・動画・音声・PDF だけ。Range に答える（動画・音声を seek できる）
 * - fs:inspect                      … 大きさと先頭のバイト（binary の表示の16進数）
 * どちらも src/main/files.ts の resolveInside で、プロジェクトの外・外を指すリンクを断ってから触る。
 * パイプ・デバイス・フォルダは開かない（開くと main が止まる）。全体をメモリへ載せない（ストリームで返す）。
 */
import { relativeInside, resolveInside } from './files'
import { openContained } from './containedFile'
import { mediaResponseFromHandle } from './mediaRange'
import { BINARY_HEAD_BYTES, MAX_VIEWER_BYTES, mediaTypeOf, projectMediaPathFromUrl, type FsFileInfo } from '@shared/fileViewer'
import { MAX_OFFICE_BYTES, officeKindOf } from '@shared/office/kinds'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'

/**
 * SVG を直に開かれても中のスクリプトを動かさない。PDF は内蔵の PDF ビューアが動けるよう付けない
 * （ほかの種類はスクリプトを持たない）
 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
}

/** ade-media://project/... に答える。root はいま開いているプロジェクト（無ければ 404） */
export async function projectMediaResponse(root: string | null, url: string, rangeHeader: string | null): Promise<Response> {
  const rel = projectMediaPathFromUrl(url)
  const media = rel ? mediaTypeOf(rel) : null
  if (!root || !rel || !media) return notFound()
  let file: string
  try {
    file = await resolveInside(root, rel)
  } catch {
    // 外を指す・無いファイル（想定内）
    return notFound()
  }
  // 開いたものがプロジェクトの中の実体かを確かめ、その fd から返す（確かめたあとでリンクに差し替えられても外を読まない。security-4 [5]）
  const handle = await openContained(root, file, 'read').catch(() => null)
  if (!handle) return notFound()
  const info = await handle.stat().catch(() => null)
  if (!info?.isFile() || info.size > MAX_VIEWER_BYTES[media.kind]) {
    await handle.close()
    return info?.isFile() ? new Response('Too large', { status: 413, headers: { 'Content-Type': 'text/plain' } }) : notFound()
  }
  const response = await mediaResponseFromHandle(handle, rangeHeader, media.type)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Cache-Control', 'no-store')
  if (media.type === 'image/svg+xml') response.headers.set('Content-Security-Policy', SVG_CSP)
  return response
}

/** 大きさと先頭のバイト。普通のファイルでなければ断る */
export async function inspectProjectFile(root: string, relPath: string): Promise<FsFileInfo> {
  const file = await resolveInside(root, relPath)
  // 開いたものがプロジェクトの中の実体かを確かめる（security-4 [5]）。O_NONBLOCK で開くのでパイプでも止まらない
  const handle = await openContained(root, file, 'read')
  try {
    if ((await handle.stat()).isDirectory()) throw new UserFacingError(t('files.errors.folder'))
    const info = await handle.stat()
    if (!info.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
    const head = Buffer.alloc(Math.min(BINARY_HEAD_BYTES, info.size))
    const { bytesRead } = head.length > 0 ? await handle.read(head, 0, head.length, 0) : { bytesRead: 0 }
    return { path: relativeInside(root, file) ?? relPath, size: info.size, mtimeMs: info.mtimeMs, head: new Uint8Array(head.subarray(0, bytesRead)) }
  } finally {
    await handle.close()
  }
}

/** Office の文書の中身（fs:readOffice）。Office の拡張子・普通のファイル・上限以下のものだけ */
export async function readOfficeFile(root: string, relPath: string): Promise<Uint8Array> {
  if (!officeKindOf(relPath)) throw new UserFacingError(t('viewer.loadFailed'))
  const file = await resolveInside(root, relPath)
  // 開いたものがプロジェクトの中の実体かを確かめ、その fd から読む（security-4 [5]）
  const handle = await openContained(root, file, 'read')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
    if (info.size > MAX_OFFICE_BYTES) throw new UserFacingError(t('viewer.loadFailed'))
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
  } finally {
    await handle.close()
  }
}
