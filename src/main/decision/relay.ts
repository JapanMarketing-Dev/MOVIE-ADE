/**
 * 判定モデルのローカル中継（127.0.0.1 の空いているポート）。
 *
 * Agent は feedback.md の手順で判定モデルを呼ぶ。直接プロバイダへ送ると Ferret からは回数も費用も見えないので、
 * Agent には中継の URL（起動ごとの合言葉 t= 付き）だけを渡し、中継が本当の接続先へそのまま送り直す。
 *   - キーと追加のヘッダーは中継が付ける。Agent の環境変数・指示文・会話の記録にキーは出ない
 *   - 合言葉の無い・違う依頼は断る（ほかのローカルのプロセスに利用者のキーを使わせない）
 *   - 応答は状態コードも本文も変えずに返す（Cloudflare の { result, success } の包みもそのまま）
 *   - 1回ごとに数だけを記録する（callLog.ts）。画像・本文・キーは残さない
 * Ferret が自分から判定モデルを呼ぶことはない。利用者の支払いも今までどおりプロバイダへ直接。
 *
 * Electron に依存させない（単体テストでローカルの偽の接続先に向けるため）。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DecisionPricing } from '@shared/decision'
import type { ApiCallRecord } from '@shared/apiUsage'
import { estimateCost, extractUsage } from './callLog'
import { AI_RESPONSE_MAX_BYTES, ResponseTooLargeError, readBoundedBytes } from '../boundedResponse'

/** 画像を2枚含むので大きめ */
const RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024
const RELAY_PATH = '/v1/systemone'
export const RELAY_TOKEN_HEADER = 'x-ferret-token'
/** @deprecated 改名前のヘッダー名。受け付けるだけ */
export const LEGACY_RELAY_TOKEN_HEADER = 'x-movie-ade-token'

export interface RelayUpstream {
  url: string
  /** キーのヘッダーと追加のヘッダー（解決済み）。値は記録・エラーに出さない */
  headers: Record<string, string>
  provider: string
  model: string
  pricing?: DecisionPricing
  timeoutMs: number
}

export interface RelayTokenMeta {
  projectId?: string
  agent?: string
  /** 合言葉を渡したターミナルの ID。ターミナルが閉じたら revokeSession で無効にする */
  sessionId?: string
}

/** 1つの合言葉で同時に送れる依頼の数 */
export const RELAY_MAX_CONCURRENT_PER_TOKEN = 4
/** 出してからこの時間で無効にする（長い作業でも、ターミナルを開き直せば新しい合言葉になる） */
export const RELAY_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface IssuedToken {
  meta: RelayTokenMeta
  issuedAt: number
}

/** 接続先を決められない（URL・アカウント ID・キーが無いなど）。Agent へは 400 と理由を返す */
export class RelayConfigError extends Error {}

interface DecisionRelayOptions {
  /** 依頼のたびに呼ぶ。キーの復号は初めて呼ばれたときだけ行い、呼び出し側で覚えておく */
  upstream: () => Promise<RelayUpstream>
  onCall?: (record: ApiCallRecord) => void
  maxBodyBytes?: number
  /** 接続先の応答の上限。超えたら読むのをやめ、Agent へは 502 を返す */
  maxResponseBytes?: number
  tokenMaxAgeMs?: number
  fetch?: typeof fetch
  now?: () => Date
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const relayError = (message: string, type: string) => ({ message, error_type: type, source: 'ferret-relay' })

/** 依頼の本文から数だけ（画像の枚数）を読む。本文そのものは残さない */
function countImages(body: Buffer): number | undefined {
  try {
    const images = (JSON.parse(body.toString('utf8')) as { images?: unknown }).images
    return Array.isArray(images) ? images.length : 0
  } catch {
    // JSON でない依頼はそのまま送る（接続先が理由を返す）。枚数は分からない（想定内）
    return undefined
  }
}

export class DecisionRelay {
  private server: Server | null = null
  private readonly tokens = new Map<string, IssuedToken>()
  /** 合言葉ごとの、送っている途中の依頼の数 */
  private readonly inflight = new Map<string, number>()
  private readonly maxBody: number
  private readonly maxResponse: number
  private readonly doFetch: typeof fetch

  constructor(private readonly opt: DecisionRelayOptions) {
    this.maxBody = opt.maxBodyBytes ?? RELAY_MAX_BODY_BYTES
    this.maxResponse = opt.maxResponseBytes ?? AI_RESPONSE_MAX_BYTES
    this.doFetch = opt.fetch ?? fetch
  }

  get port(): number | null {
    const address = this.server?.address() as AddressInfo | null | undefined
    return address?.port ?? null
  }

  get running(): boolean {
    return this.port !== null
  }

  /** 127.0.0.1 の空いているポートで待ち受ける。起動済みならそのポート */
  async start(): Promise<number> {
    if (this.port !== null) return this.port
    const server = createServer((req, res) => void this.handle(req, res))
    // 画像付きの判定は時間がかかる。接続先の待ち時間より短く切らない
    server.requestTimeout = 0
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
      // 中継があってもアプリの終了を止めない
      server.unref()
    })
    return this.port!
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.tokens.clear()
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private nowMs(): number {
    return (this.opt.now?.() ?? new Date()).getTime()
  }

  /**
   * Agent の起動ごとに合言葉を1つ出す。どの Agent の呼び出しかを記録に使う。
   * 合言葉はターミナル（sessionId）に結び付け、閉じたら・判定を無効にしたら無効にする（提供元・キー・モデルの変更では切らない）。
   * 出してから RELAY_TOKEN_MAX_AGE_MS で切れる
   */
  issue(meta: RelayTokenMeta = {}): string {
    const token = randomBytes(18).toString('base64url')
    const now = this.nowMs()
    this.tokens.set(token, { meta, issuedAt: now })
    return token
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }

  /** そのターミナルに渡した合言葉をすべて無効にする（ターミナルが閉じたとき） */
  revokeSession(sessionId: string): void {
    for (const [token, issued] of this.tokens) if (issued.meta.sessionId === sessionId) this.tokens.delete(token)
  }

  /** 出した合言葉をすべて無効にする（判定を無効にしたとき） */
  revokeAll(): void {
    this.tokens.clear()
  }

  /** 有効な合言葉なら、その情報を返す。切れていれば消して undefined */
  private accept(token: string): RelayTokenMeta | undefined {
    const issued = this.tokens.get(token)
    if (!issued) return undefined
    const now = this.nowMs()
    if (now - issued.issuedAt > (this.opt.tokenMaxAgeMs ?? RELAY_TOKEN_MAX_AGE_MS)) {
      this.tokens.delete(token)
      return undefined
    }
    return issued.meta
  }

  /** Agent に渡す URL（合言葉付き） */
  urlFor(token: string): string {
    if (this.port === null) throw new Error('relay is not running')
    return `http://127.0.0.1:${this.port}${RELAY_PATH}?t=${encodeURIComponent(token)}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== RELAY_PATH) return sendJson(res, 404, relayError('Not found. POST to /v1/systemone.', 'relay_not_found'))
    if (req.method !== 'POST') return sendJson(res, 405, relayError('Use POST.', 'relay_method'))
    const header = req.headers[RELAY_TOKEN_HEADER] ?? req.headers[LEGACY_RELAY_TOKEN_HEADER]
    const token = url.searchParams.get('t') ?? (typeof header === 'string' ? header : '')
    const meta = token ? this.accept(token) : undefined
    if (!meta) {
      req.resume()
      return sendJson(res, 401, relayError('Missing or invalid Ferret relay token. Use $FERRET_DECISION_URL exactly as given.', 'relay_unauthorized'))
    }
    // 1つの合言葉で同時に送れる数を絞る（写し取った合言葉で並べて呼び、費用やメモリを膨らませない）
    const inflight = this.inflight.get(token) ?? 0
    if (inflight >= RELAY_MAX_CONCURRENT_PER_TOKEN) {
      req.resume()
      return sendJson(res, 429, relayError(`Too many decision requests at once (max ${RELAY_MAX_CONCURRENT_PER_TOKEN}). Wait for the previous ones to finish.`, 'relay_too_many'))
    }
    this.inflight.set(token, inflight + 1)
    try {
      await this.forward(req, res, meta)
    } finally {
      const left = (this.inflight.get(token) ?? 1) - 1
      if (left > 0) this.inflight.set(token, left)
      else this.inflight.delete(token)
    }
  }

  private async forward(req: IncomingMessage, res: ServerResponse, meta: RelayTokenMeta): Promise<void> {
    const body = await this.readBody(req, res)
    if (!body) return
    const started = Date.now()
    const base = { kind: 'decision' as const, ...(meta.projectId ? { projectId: meta.projectId } : {}), ...(meta.agent ? { agent: meta.agent } : {}), requestBytes: body.length }
    const images = countImages(body)
    let upstream: RelayUpstream
    try {
      upstream = await this.opt.upstream()
    } catch (err) {
      const message = err instanceof RelayConfigError ? err.message : 'Ferret could not prepare the decision API settings.'
      return sendJson(res, 400, relayError(message, 'relay_config'))
    }
    const record = (status: number, extra: Partial<ApiCallRecord> = {}) => this.opt.onCall?.({
      ts: (this.opt.now?.() ?? new Date()).toISOString(), ...base, provider: upstream.provider, model: upstream.model,
      status, latencyMs: Date.now() - started, ...(images !== undefined ? { images } : {}), ...extra
    })
    let upstreamRes: Response
    try {
      upstreamRes = await this.doFetch(upstream.url, {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json', ...upstream.headers },
        // Buffer は型の上で BodyInit にならない環境がある（DOM の型）。同じバイト列の Uint8Array で渡す
        body: Uint8Array.from(body),
        signal: AbortSignal.timeout(upstream.timeoutMs)
      })
    } catch (err) {
      const timeout = (err as { name?: string } | null)?.name === 'TimeoutError'
      record(0)
      return sendJson(res, timeout ? 504 : 502, timeout
        ? relayError(`The decision API did not answer within ${Math.round(upstream.timeoutMs / 1000)}s.`, 'relay_upstream_timeout')
        : relayError('Ferret relay could not reach the decision API. Check that it is running and that the URL in Ferret settings is right.', 'relay_upstream_unreachable'))
    }
    let out: Buffer
    try {
      out = await readBoundedBytes(upstreamRes, this.maxResponse)
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        // 大きすぎる応答は溜めずに切る（設定した接続先が巨大な本文を返してもメモリを使い切らない）
        record(upstreamRes.status)
        return sendJson(res, 502, relayError(`The decision API response was larger than ${Math.round(this.maxResponse / 1024 / 1024)}MB, so Ferret stopped reading it.`, 'relay_upstream_too_large'))
      }
      // 本文を読み切れなかった（途中で切れた）ときは、空で返す（想定内）
      out = Buffer.alloc(0)
    }
    const headers: Record<string, string> = { 'content-length': String(out.length) }
    const contentType = upstreamRes.headers.get('content-type')
    if (contentType) headers['content-type'] = contentType
    res.writeHead(upstreamRes.status, headers)
    res.end(out)
    let usage: ReturnType<typeof extractUsage> = {}
    // JSON でない応答（エラーページなど）はトークン数が分からないだけ（想定内）
    try { usage = extractUsage(JSON.parse(out.toString('utf8'))) } catch { usage = {} }
    const estimated = usage.costUsd === undefined ? estimateCost(usage, upstream.pricing) : undefined
    record(upstreamRes.status, {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd, costSource: 'provider' as const } : estimated !== undefined ? { costUsd: estimated, costSource: 'estimate' as const } : {})
    })
  }

  /** 上限を超えたら 413 を返して null */
  private readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      req.on('data', (chunk: Buffer) => {
        if (over) return
        size += chunk.length
        if (size > this.maxBody) {
          over = true
          chunks.length = 0
          res.setHeader('connection', 'close')
          sendJson(res, 413, relayError(`Request body is larger than ${Math.round(this.maxBody / 1024 / 1024)}MB. Send smaller images.`, 'relay_too_large'))
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)) })
      req.on('error', () => resolve(null))
    })
  }
}
