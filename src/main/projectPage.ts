/**
 * 内蔵ブラウザで開くプロジェクトの HTML とその部品（CSS・スクリプト・画像など）を返す（ade-page://project/<相対パス>。security-7 [2][6]）。
 *
 * - いま開いているプロジェクトの中の普通のファイルだけ。外・外を指すリンク・パイプ・フォルダは断る（resolveInside と、開いた fd の確認）
 * - 外へは通信させない CSP を付ける。ページの中のスクリプト・スタイル・画像・フォントは同じオリジン（プロジェクトの中）と data: / blob: だけ。
 *   外の画像・スクリプト・fetch・フォームの送信・外の iframe は読み込まない（外のページは、利用者が URL 欄に入れたときだけ開く）
 * - 種類は拡張子で決め、nosniff にする（知らない拡張子は text/plain。中身から HTML とみなさせない）
 * 内蔵ブラウザの session にだけ登録する（アプリの画面の session からは読めない）。
 */
import { Readable } from 'node:stream'
import { resolveInside } from './files'
import { openContained } from './containedFile'
import { projectPathFromPageUrl } from '@shared/htmlPreview'

/** 1つのファイルの上限（動画などの大きいものは、ページの部品として読ませない） */
export const MAX_PAGE_FILE_BYTES = 200 * 1024 * 1024

/** プロジェクトのページの CSP。ページが自分で外へ通信できない（同じオリジンと data: / blob: だけ） */
export const PROJECT_PAGE_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "form-action 'none'",
  "base-uri 'self'"
].join('; ')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.apng': 'image/apng', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf'
}

export function projectPageContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? TYPES[name.slice(dot).toLowerCase()] : undefined) ?? 'text/plain; charset=utf-8'
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Content-Security-Policy': PROJECT_PAGE_CSP } })
}

/** ade-page://project/... に答える。root はいま開いているプロジェクト（無ければ 404） */
export async function projectPageResponse(root: string | null, url: string): Promise<Response> {
  const rel = projectPathFromPageUrl(url)
  if (!root || !rel) return notFound()
  let file: string
  try {
    file = await resolveInside(root, rel)
  } catch {
    // 外を指す・無いファイル（想定内）
    return notFound()
  }
  // 開いたものがプロジェクトの中の実体かを確かめ、その fd から返す（確かめたあとでリンクに差し替えられても外を読まない）
  const handle = await openContained(root, file, 'read').catch(() => null)
  if (!handle) return notFound()
  const info = await handle.stat().catch(() => null)
  if (!info?.isFile() || info.size > MAX_PAGE_FILE_BYTES) {
    await handle.close()
    return notFound()
  }
  const body = info.size > 0 ? Readable.toWeb(handle.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array> : null
  if (!body) await handle.close()
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': projectPageContentType(rel),
      'Content-Length': String(info.size),
      'Content-Security-Policy': PROJECT_PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }
  })
}
