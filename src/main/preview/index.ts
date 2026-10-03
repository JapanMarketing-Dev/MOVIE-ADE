/// <reference types="electron-vite/node" />
import { readFile } from 'node:fs/promises'
import type { Session, WebContents } from 'electron'
import mermaidScript from 'mermaid/dist/mermaid.min.js?asset'
// 小さいページのスタイルとスクリプトは文字列として埋め込む（CSS は ?asset だと Vite の CSS 処理に取られる）
import pageScript from './page.js?raw'
import pageStyle from './page.css?raw'
import { PREVIEW_ASSET_HOST, PREVIEW_PROJECT_HOST, PREVIEW_SCHEME, previewKind, previewPathFromUrl } from '@shared/preview'
import { readTextFile, resolveInside } from '../files'
import { renderPreviewBody, renderPreviewMessage, renderPreviewPage } from './render'
import { t } from '@shared/i18n'
import { reportHandled } from '@shared/report'

/**
 * markdown / Mermaid のプレビューを返すカスタムプロトコル（ade-preview://）。
 *
 * renderer の DOM ではなく内蔵ブラウザ（WebContentsView）で開くページにすることで、
 * 録画・ペンと文字の書き込み・要素情報の仕組みがそのまま使える（指摘の URL にファイルの相対パスが残る）。
 * ファイルの読み出しは src/main/files.ts の検査を通す（プロジェクトの外・外を指すリンクは断る）。
 * Mermaid は npm の同梱版を返す（CDN は使わない。オフラインでも描ける）。
 */

/** 同梱のアセット。Mermaid（5MB 強）はファイルのまま置き、使うときだけ読む */
const ASSETS: Record<string, { load: () => Promise<string | Buffer>; type: string }> = {
  'mermaid.js': { load: () => readFile(mermaidScript), type: 'text/javascript; charset=utf-8' },
  'preview.js': { load: async () => pageScript, type: 'text/javascript; charset=utf-8' },
  'preview.css': { load: async () => pageStyle, type: 'text/css; charset=utf-8' }
}

/** markdown から参照される画像だけは、プロジェクトの中から生のまま返す */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

/**
 * ページのスクリプトは同梱の2本だけ。Mermaid の SVG は style 属性を使うので style は inline を許す。
 * 外部の画像（README のバッジなど）は https で読ませる。
 */
const CSP = [
  "default-src 'none'",
  `script-src ${PREVIEW_SCHEME}:`,
  `style-src ${PREVIEW_SCHEME}: 'unsafe-inline'`,
  `img-src ${PREVIEW_SCHEME}: data: https:`,
  `font-src ${PREVIEW_SCHEME}: data:`,
  `connect-src ${PREVIEW_SCHEME}:`
].join('; ')

function respond(body: string | Buffer, type: string, status = 200): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status,
    headers: { 'Content-Type': type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }
  })
}

const HTML = 'text/html; charset=utf-8'

async function handle(request: Request, getRoot: () => string | null): Promise<Response> {
  const url = new URL(request.url)

  if (url.hostname === PREVIEW_ASSET_HOST) {
    const asset = ASSETS[url.pathname.replace(/^\/+/, '')]
    if (!asset) return respond('Not found', 'text/plain', 404)
    return respond(await asset.load(), asset.type)
  }

  const root = getRoot()
  const path = previewPathFromUrl(request.url)
  if (url.hostname !== PREVIEW_PROJECT_HOST || !root || !path) return respond('Not found', 'text/plain', 404)

  // 画像は生のまま返す（markdown から参照される）。md / Mermaid 以外のテキストは読み取り専用のコードのページ
  const dot = path.lastIndexOf('.')
  const imageType = dot === -1 ? undefined : IMAGE_TYPES[path.slice(dot).toLowerCase()]
  if (imageType) {
    try {
      return respond(await readFile(await resolveInside(root, path)), imageType)
    } catch {
      // 無い画像・プロジェクトの外を指す画像（想定内）
      return respond('Not found', 'text/plain', 404)
    }
  }
  const kind = previewKind(path) ?? 'code'

  let body: string
  try {
    const result = await readTextFile(root, path)
    body = result.kind === 'text' ? renderPreviewBody(kind, result.content) : renderPreviewMessage(result.reason)
  } catch (err) {
    const message = err instanceof Error && err.message === t('files.errors.outside') ? err.message : t('preview.readFailed')
    body = renderPreviewMessage(message)
  }
  // ?fragment=1 は保存のたびに page.js が取り直す中身だけ
  if (url.searchParams.get('fragment') === '1') return respond(body, HTML)
  return respond(renderPreviewPage({ path, kind, body }), HTML)
}

/**
 * セッションごとに登録する（内蔵ブラウザは別の partition、エディタの横並びの iframe は既定のセッション）。
 * スキームの特権（standard / secure / fetch）は app の ready 前に registerSchemesAsPrivileged で宣言しておくこと。
 */
export function registerPreviewProtocol(sessions: Session[], getRoot: () => string | null): void {
  for (const ses of sessions) {
    if (ses.protocol.isProtocolHandled(PREVIEW_SCHEME)) continue
    ses.protocol.handle(PREVIEW_SCHEME, (request) =>
      handle(request, getRoot).catch((err: unknown) => {
        console.warn('[preview] プレビューを返せませんでした', err)
    reportHandled(err, { area: 'preview', op: 'serve preview' })
        return respond('Error', 'text/plain', 500)
      })
    )
  }
}

/** 編集中の内容をページの中身にする（ファイルは読まないので、パスは種類の判定にだけ使う） */
export function renderPreviewSource(path: unknown, source: unknown): string {
  const kind = typeof path === 'string' ? previewKind(path) : null
  if (!kind || typeof source !== 'string') return ''
  return renderPreviewBody(kind, source)
}

/**
 * 内蔵ブラウザがプレビューを開いていて、そのファイルが変わったら中身だけ差し替えさせる。
 * reload() にしないのは、録画中の書き込み（注入スクリプト）を消さないため。
 */
export function refreshPreviewIn(contents: WebContents | null, changedPaths: readonly string[]): void {
  if (!contents || contents.isDestroyed()) return
  const path = previewPathFromUrl(contents.getURL())
  if (!path || !changedPaths.includes(path)) return
  // 読み込み中・破棄済みのページでは呼べない（想定内。次の変更で呼び直す）
  void contents.executeJavaScript('window.__adePreviewRefresh && window.__adePreviewRefresh()').catch(() => undefined)
}
