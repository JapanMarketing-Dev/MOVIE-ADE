/**
 * 判定モデルのローカル中継（127.0.0.1 の空いているポート）。
 *
 * Agent は feedback.md の手順で判定モデルを呼ぶ。直接プロバイダへ送ると Ferret からは回数も費用も見えないので、
 * Agent には中継の URL（起動ごとの合言葉 t= 付き）だけを渡し、中継が本当の接続先へそのまま送り直す。
 *   - キーと追加のヘッダーは中継が付ける。Agent の環境変数・指示文・会話の記録にキーは出ない
 *   - 合言葉の無い・違う依頼は断る（ほかのローカルのプロセスに利用者のキーを使わせない）
 *   - 応答は状態コードも本文も変えずに返す（Cloudflare の { result, success } の包みもそのまま）
 *   - 1回ごとに数だけを記録する（callLog.ts）。画像・本文・キーは残さない
 *   - 合言葉ごと・プロジェクトごとに、回数・1分あたりの回数・トークン数・費用の総量の枠を持つ（security-5 [4]）。
 *     枠は送る前に予約し（同時の依頼でも超えない）、応答の数で精算する。合言葉の枠を使い切ったら合言葉を無効にする
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

/**
 * 写し取った合言葉で、順番に（同時の数の上限の下で）いくらでも呼べないようにする総量の枠（security-5 [4]）。
 * 合言葉の枠を使い切ったら、その合言葉は無効になる（ターミナルを開き直すと新しい枠）。
 * 費用は応答に入っている・単価を設定しているときだけ分かる。分からない呼び出しは回数とトークン数の枠で止まる
 */
export const RELAY_BUDGET = {
  /** 1つの合言葉で送れる回数 */
  callsPerToken: 500,
  /** 1つの合言葉で1分間に送れる回数 */
  callsPerMinute: 30,
  /** 1つの合言葉で使えるトークン数（入力＋出力） */
  tokensPerToken: 20_000_000,
  /** 1つの合言葉で使える費用（USD） */
  usdPerToken: 5,
  /** 1つのプロジェクト（合言葉をまたいで）で1日に送れる回数 */
  callsPerProjectPerDay: 2000,
  /** 1つのプロジェクトで1日に使える費用（USD） */
  usdPerProjectPerDay: 20
} as const

export type RelayBudget = { [K in keyof typeof RELAY_BUDGET]: number }

/** 使った量と、送っている途中の依頼のために押さえている量 */
interface Usage {
  calls: number
  tokens: number
  usd: number
  /** 1回の呼び出しで見た最大（送る前に、これだけを押さえる） */
  maxCallTokens: number
  maxCallUsd: number
  heldTokens: number
  heldUsd: number
}

const emptyUsage = (): Usage => ({ calls: 0, tokens: 0, usd: 0, maxCallTokens: 0, maxCallUsd: 0, heldTokens: 0, heldUsd: 0 })

interface IssuedToken {
  meta: RelayTokenMeta
  issuedAt: number
  usage: Usage
  /** 直近1分の送った時刻 */
  recent: number[]
}

/** 送る前の予約。応答のあとで settle する */
interface Reservation {
  token: IssuedToken
  project: Usage | null
  heldTokens: number
  heldUsd: number
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
  /** 総量の枠（テスト用に小さくする）。省略時は RELAY_BUDGET */
  budget?: Partial<RelayBudget>
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
  /** プロジェクトごとの、その日の使った量（日付が変わったら空にする） */
  private readonly projectUsage = new Map<string, { day: string; usage: Usage }>()
  private readonly budget: RelayBudget
  private readonly maxBody: number
  private readonly maxResponse: number
  private readonly doFetch: typeof fetch

  constructor(private readonly opt: DecisionRelayOptions) {
    this.maxBody = opt.maxBodyBytes ?? RELAY_MAX_BODY_BYTES
    this.maxResponse = opt.maxResponseBytes ?? AI_RESPONSE_MAX_BYTES
    this.doFetch = opt.fetch ?? fetch
    this.budget = { ...RELAY_BUDGET, ...opt.budget }
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
    this.tokens.set(token, { meta, issuedAt: now, usage: emptyUsage(), recent: [] })
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
  private accept(token: string): IssuedToken | undefined {
    const issued = this.tokens.get(token)
    if (!issued) return undefined
    const now = this.nowMs()
    if (now - issued.issuedAt > (this.opt.tokenMaxAgeMs ?? RELAY_TOKEN_MAX_AGE_MS)) {
      this.tokens.delete(token)
      return undefined
    }
    return issued
  }

  /** そのプロジェクトの今日の使った量（日付が変わっていたら空から） */
  private projectUsageFor(projectId: string | undefined): Usage | null {
    if (!projectId) return null
    const at = this.opt.now?.() ?? new Date()
    const day = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`
    const entry = this.projectUsage.get(projectId)
    if (entry?.day === day) return entry.usage
    const usage = emptyUsage()
    this.projectUsage.set(projectId, { day, usage })
    return usage
  }

  /**
   * 送る前に枠を予約する（同期で数えるので、同時に来た依頼でも枠を超えない）。
   * 合言葉の枠を使い切っていれば合言葉を無効にする。断るときは理由の種類を返す
   */
  private reserve(tokenKey: string, issued: IssuedToken): Reservation | { refused: 'token' | 'busy' | 'rate' | 'project' } {
    const b = this.budget
    const now = this.nowMs()
    issued.recent = issued.recent.filter((at) => now - at < 60_000)
    const u = issued.usage
    // 次の1回で見込む量（これまでの1回の最大）を押さえても枠に収まるか
    const heldTokens = u.maxCallTokens
    const heldUsd = u.maxCallUsd
    // 使い切った（途中の依頼が無くても次の1回が収まらない）なら合言葉を無効にする。途中の依頼の分で収まらないだけなら待ってもらう
    const exhausted = u.calls >= b.callsPerToken || u.tokens + heldTokens > b.tokensPerToken || u.usd + heldUsd > b.usdPerToken
      || u.tokens >= b.tokensPerToken || u.usd >= b.usdPerToken
    if (exhausted) {
      this.tokens.delete(tokenKey)
      return { refused: 'token' }
    }
    if (u.tokens + u.heldTokens + heldTokens > b.tokensPerToken || u.usd + u.heldUsd + heldUsd > b.usdPerToken) return { refused: 'busy' }
    if (issued.recent.length >= b.callsPerMinute) return { refused: 'rate' }
    const project = this.projectUsageFor(issued.meta.projectId)
    if (project && (project.calls >= b.callsPerProjectPerDay || project.usd + project.heldUsd + heldUsd > b.usdPerProjectPerDay)) return { refused: 'project' }
    u.calls++
    u.heldTokens += heldTokens
    u.heldUsd += heldUsd
    issued.recent.push(now)
    if (project) {
      project.calls++
      project.heldUsd += heldUsd
    }
    return { token: issued, project, heldTokens, heldUsd }
  }

  /** 応答の数で精算する（押さえた分を外し、実際の量を足す）。合言葉の枠を使い切ったら無効にする */
  private settle(tokenKey: string, r: Reservation, used: { tokens: number; usd: number }): void {
    const u = r.token.usage
    u.heldTokens = Math.max(0, u.heldTokens - r.heldTokens)
    u.heldUsd = Math.max(0, u.heldUsd - r.heldUsd)
    u.tokens += used.tokens
    u.usd += used.usd
    u.maxCallTokens = Math.max(u.maxCallTokens, used.tokens)
    u.maxCallUsd = Math.max(u.maxCallUsd, used.usd)
    if (r.project) {
      r.project.heldUsd = Math.max(0, r.project.heldUsd - r.heldUsd)
      r.project.usd += used.usd
    }
    // 使い切った合言葉は、次の依頼で理由（relay_budget_exhausted）を返してから無効にする（reserve）
    void tokenKey
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
    const issued = token ? this.accept(token) : undefined
    if (!issued) {
      req.resume()
      return sendJson(res, 401, relayError('Missing or invalid Ferret relay token. Use $FERRET_DECISION_URL exactly as given.', 'relay_unauthorized'))
    }
    // 1つの合言葉で同時に送れる数を絞る（写し取った合言葉で並べて呼び、費用やメモリを膨らませない）
    const inflight = this.inflight.get(token) ?? 0
    if (inflight >= RELAY_MAX_CONCURRENT_PER_TOKEN) {
      req.resume()
      return sendJson(res, 429, relayError(`Too many decision requests at once (max ${RELAY_MAX_CONCURRENT_PER_TOKEN}). Wait for the previous ones to finish.`, 'relay_too_many'))
    }
    // 総量の枠を送る前に予約する（security-5 [4]）
    const reservation = this.reserve(token, issued)
    if ('refused' in reservation) {
      req.resume()
      const refusals = {
        token: relayError('This terminal used up its decision-model budget, so Ferret ended its relay token. Open a new terminal tab to continue.', 'relay_budget_exhausted'),
        busy: relayError('This terminal is close to its decision-model budget. Wait for the previous requests to finish.', 'relay_budget_pending'),
        rate: relayError(`Too many decision requests in one minute (max ${this.budget.callsPerMinute}). Wait a minute and try again.`, 'relay_rate_limited'),
        project: relayError('This project reached today\'s decision-model budget in Ferret. Try again tomorrow.', 'relay_project_budget')
      }
      return sendJson(res, 429, refusals[reservation.refused])
    }
    this.inflight.set(token, inflight + 1)
    let used = { tokens: 0, usd: 0 }
    try {
      used = await this.forward(req, res, issued.meta)
    } finally {
      this.settle(token, reservation, used)
      const left = (this.inflight.get(token) ?? 1) - 1
      if (left > 0) this.inflight.set(token, left)
      else this.inflight.delete(token)
    }
  }

  /** 送って応答を返す。精算のために、使ったトークン数と費用（分かった分）を返す */
  private async forward(req: IncomingMessage, res: ServerResponse, meta: RelayTokenMeta): Promise<{ tokens: number; usd: number }> {
    const none = { tokens: 0, usd: 0 }
    const body = await this.readBody(req, res)
    if (!body) return none
    const started = Date.now()
    const base = { kind: 'decision' as const, ...(meta.projectId ? { projectId: meta.projectId } : {}), ...(meta.agent ? { agent: meta.agent } : {}), requestBytes: body.length }
    const images = countImages(body)
    let upstream: RelayUpstream
    try {
      upstream = await this.opt.upstream()
    } catch (err) {
      const message = err instanceof RelayConfigError ? err.message : 'Ferret could not prepare the decision API settings.'
      sendJson(res, 400, relayError(message, 'relay_config'))
      return none
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
      sendJson(res, timeout ? 504 : 502, timeout
        ? relayError(`The decision API did not answer within ${Math.round(upstream.timeoutMs / 1000)}s.`, 'relay_upstream_timeout')
        : relayError('Ferret relay could not reach the decision API. Check that it is running and that the URL in Ferret settings is right.', 'relay_upstream_unreachable'))
      return none
    }
    let out: Buffer
    try {
      out = await readBoundedBytes(upstreamRes, this.maxResponse)
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        // 大きすぎる応答は溜めずに切る（設定した接続先が巨大な本文を返してもメモリを使い切らない）
        record(upstreamRes.status)
        sendJson(res, 502, relayError(`The decision API response was larger than ${Math.round(this.maxResponse / 1024 / 1024)}MB, so Ferret stopped reading it.`, 'relay_upstream_too_large'))
        return none
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
    const cost = usage.costUsd ?? estimated
    record(upstreamRes.status, {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd, costSource: 'provider' as const } : estimated !== undefined ? { costUsd: estimated, costSource: 'estimate' as const } : {})
    })
    return { tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), usd: cost ?? 0 }
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
