/**
 * エディタで文字として開けないファイル（画像・動画・音声・PDF・その他のバイナリ）の中身を返す。
 *
 * - ade-media://project/<相対パス> … 画像・動画・音声・PDF だけ。Range に答える（動画・音声を seek できる）
 * - fs:inspect                      … 大きさと先頭のバイト（binary の表示の16進数）
 * どちらも src/main/files.ts の resolveInside で、プロジェクトの外・外を指すリンクを断ってから触る。
 * パイプ・デバイス・フォルダは開かない（開くと main が止まる）。全体をメモリへ載せない（ストリームで返す）。
 */
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { relativeInside, resolveInside } from './files'
import { mediaResponse } from './mediaRange'
import { BINARY_HEAD_BYTES, MAX_VIEWER_BYTES, mediaTypeOf, projectMediaPathFromUrl, type FsFileInfo } from '@shared/fileViewer'
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
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return notFound()
  if (info.size > MAX_VIEWER_BYTES[media.kind]) return new Response('Too large', { status: 413, headers: { 'Content-Type': 'text/plain' } })
  const response = await mediaResponse(file, rangeHeader, media.type)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Cache-Control', 'no-store')
  if (media.type === 'image/svg+xml') response.headers.set('Content-Security-Policy', SVG_CSP)
  return response
}

/** 大きさと先頭のバイト。普通のファイルでなければ断る */
export async function inspectProjectFile(root: string, relPath: string): Promise<FsFileInfo> {
  const file = await resolveInside(root, relPath)
  const before = await stat(file)
  if (before.isDirectory()) throw new UserFacingError(t('files.errors.folder'))
  if (!before.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
  // O_NONBLOCK: 確かめたあとにパイプへ差し替えられても、開くところで止まらない
  const handle = await open(file, constants.O_RDONLY | ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
    const head = Buffer.alloc(Math.min(BINARY_HEAD_BYTES, info.size))
    const { bytesRead } = head.length > 0 ? await handle.read(head, 0, head.length, 0) : { bytesRead: 0 }
    return { path: relativeInside(root, file) ?? relPath, size: info.size, mtimeMs: info.mtimeMs, head: new Uint8Array(head.subarray(0, bytesRead)) }
  } finally {
    await handle.close()
  }
}
