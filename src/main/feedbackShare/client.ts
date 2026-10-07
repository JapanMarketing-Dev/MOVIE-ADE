/**
 * 共有リンクの Worker（workers/feedback-share）と話す。Electron に依存させない（単体テストで偽の fetch を渡すため）。
 * 持ち主のトークンは Authorization ヘッダーでだけ送り、URL・ログ・エラーメッセージに出さない。
 */
import {
  ITEM_ID_PATTERN,
  OWNER_TOKEN_PATTERN,
  SHARE_BASE,
  SHARE_ID_PATTERN,
  type ShareCommentStatus,
  type ShareErrorCode,
  type SharePage,
  type ShareSnapshot,
  type ShareViewport
} from '@shared/feedbackShare'

export type ShareFetch = (url: string, init: RequestInit) => Promise<Response>

/** Worker が返した失敗。code だけを持つ（本文・トークンは持たない） */
export class ShareApiError extends Error {
  constructor(readonly code: ShareErrorCode | 'network' | 'bad_response', readonly status = 0) {
    super(`feedback share: ${code}`)
  }
}

export interface ShareClientOptions {
  fetch: ShareFetch
  base?: string
  userAgent?: string
  timeoutMs?: number
}

export interface CreatedShare {
  id: string
  ownerToken: string
  url: string
  expiresAt: string
}

const ERROR_CODES = new Set(['invalid_request', 'empty', 'too_long', 'too_large', 'bad_image', 'unauthorized', 'origin_not_allowed', 'not_found', 'method_not_allowed', 'gone', 'full', 'rate_limited', 'internal'])

export class ShareClient {
  private readonly base: string

  constructor(private readonly opt: ShareClientOptions) {
    this.base = opt.base ?? SHARE_BASE
  }

  private async call(path: string, init: RequestInit, token?: string): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers)
    if (token) {
      if (!OWNER_TOKEN_PATTERN.test(token)) throw new ShareApiError('unauthorized')
      headers.set('authorization', `Bearer ${token}`)
    }
    if (this.opt.userAgent) headers.set('user-agent', this.opt.userAgent)
    let res: Response
    try {
      res = await this.opt.fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(this.opt.timeoutMs ?? 30_000) })
    } catch {
      throw new ShareApiError('network')
    }
    let body: Record<string, unknown>
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      throw new ShareApiError('bad_response', res.status)
    }
    if (!res.ok || body.ok !== true) {
      const code = typeof body.code === 'string' && ERROR_CODES.has(body.code) ? body.code as ShareErrorCode : 'bad_response'
      throw new ShareApiError(code, res.status)
    }
    return body
  }

  async create(input: { title: string; showOthers: boolean; days?: number; installId?: string }): Promise<CreatedShare> {
    const body = await this.call('/v1/shares', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const { id, ownerToken, url, expiresAt } = body as Record<string, string>
    if (!SHARE_ID_PATTERN.test(id ?? '') || !OWNER_TOKEN_PATTERN.test(ownerToken ?? '') || typeof url !== 'string' || !url.startsWith(`${this.base}/s/`) || typeof expiresAt !== 'string') {
      throw new ShareApiError('bad_response')
    }
    return { id, ownerToken, url, expiresAt }
  }

  async addPage(shareId: string, token: string, page: { url: string; title: string; viewport: ShareViewport; width: number; height: number; image: Uint8Array; type: 'image/png' | 'image/jpeg' }): Promise<SharePage> {
    assertShareId(shareId)
    const form = new FormData()
    form.set('meta', JSON.stringify({ url: page.url, title: page.title, viewport: page.viewport, width: page.width, height: page.height }))
    form.set('image', new Blob([new Uint8Array(page.image)], { type: page.type }), page.type === 'image/png' ? 'page.png' : 'page.jpg')
    const body = await this.call(`/v1/shares/${shareId}/pages`, { method: 'POST', body: form }, token)
    return body.page as SharePage
  }

  async snapshot(shareId: string, token: string): Promise<ShareSnapshot> {
    assertShareId(shareId)
    const body = await this.call(`/v1/shares/${shareId}`, { method: 'GET' }, token)
    const share = body.share as ShareSnapshot | undefined
    if (!share || !Array.isArray(share.pages) || !Array.isArray(share.comments)) throw new ShareApiError('bad_response')
    return share
  }

  async setStatus(shareId: string, token: string, commentId: string, status: ShareCommentStatus): Promise<void> {
    assertShareId(shareId)
    if (!ITEM_ID_PATTERN.test(commentId)) throw new ShareApiError('invalid_request')
    await this.call(`/v1/shares/${shareId}/comments/${commentId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }, token)
  }

  async remove(shareId: string, token: string): Promise<void> {
    assertShareId(shareId)
    await this.call(`/v1/shares/${shareId}`, { method: 'DELETE' }, token)
  }

  /** ページの静止画（相手と同じ公開の口から。持ち主のトークンは付けない）。上限を超える・画像でなければ null */
  async pageImage(shareId: string, page: Pick<SharePage, 'id' | 'ext'>, maxBytes = 8 * 1024 * 1024): Promise<Uint8Array | null> {
    assertShareId(shareId)
    if (!ITEM_ID_PATTERN.test(page.id) || (page.ext !== 'png' && page.ext !== 'jpg')) return null
    let res: Response
    try {
      res = await this.opt.fetch(`${this.base}/v1/public/${shareId}/pages/${page.id}.${page.ext}`, { method: 'GET', signal: AbortSignal.timeout(this.opt.timeoutMs ?? 30_000) })
    } catch {
      return null
    }
    if (!res.ok || !/^image\/(png|jpeg)$/.test(res.headers.get('content-type') ?? '')) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null
  }
}

function assertShareId(id: string): void {
  if (!SHARE_ID_PATTERN.test(id)) throw new ShareApiError('not_found')
}
