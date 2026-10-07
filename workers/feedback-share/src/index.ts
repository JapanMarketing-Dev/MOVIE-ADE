/**
 * ログイン無しで誰でも指摘を送れる共有リンク（Cloudflare Worker）。仕様の正本は src/shared/feedbackShare.ts、手順は README.md。
 *
 * 持ち主（Ferret のアプリの main。Origin の付いた要求は断る。トークンは Authorization: Bearer）:
 *   POST   /v1/shares                         共有を作る → { id, ownerToken, url, expiresAt }
 *   POST   /v1/shares/<id>/pages              ページ（静止画と URL）を足す（multipart: meta・image）
 *   GET    /v1/shares/<id>                    中身と指摘の一覧
 *   POST   /v1/shares/<id>/comments/<cid>     指摘の状態（取り込んだ・断った）を変える
 *   DELETE /v1/shares/<id>/comments/<cid>     指摘を消す
 *   DELETE /v1/shares/<id>                    共有を消す（静止画も）
 * 相手（ログイン無し。この Worker が配る画面から同じオリジンで）:
 *   GET    /s/<id>                            注釈の画面（静的な HTML。中身は JS が下の API から読む）
 *   GET    /v1/public/<id>                    題名・ページ・（許されていれば）ほかの人の指摘
 *   GET    /v1/public/<id>/pages/<pid>.<ext>  ページの静止画
 *   POST   /v1/public/<id>/comments           指摘を送る（JSON。Origin がこの Worker のときだけ）
 *
 * 守り:
 *   - shareId 128 bit・ownerToken 256 bit は推測できない乱数。トークンはハッシュだけを部屋に置き、URL のクエリに載せない
 *   - 画面は厳しい CSP（自分のスクリプトと画像だけ、外の CDN なし）・noindex・Referrer を送らない（ライブの iframe の先へ共有の URL を漏らさない）
 *   - 文字はすべて JS の textContent で出す（HTML として解釈しない）
 *   - 相手の送信は大きさ・項目・数の許可リストと、IP・共有・全体の頻度の上限（狭い順に予約し、断られたら先に取った予約を戻す）。honeypot に何か入っていれば保存せずに成功のふりをする
 *   - 静止画は中身で PNG / JPEG を確かめ、メタデータを取り除く（feedback-relay と同じ images.ts）
 *   - 期限（既定30日）で部屋の alarm が静止画と記録を消す
 *   - 失敗は短い code だけを返し、IP・本文・トークンはログに出さない
 */
import {
  ITEM_ID_PATTERN,
  OWNER_TOKEN_PATTERN,
  SHARE_ERROR_STATUS,
  SHARE_ID_PATTERN,
  SHARE_LIMITS,
  cleanText,
  cleanUrl,
  sanitizeCommentInput,
  shareUrl,
  type SharePage,
  type ShareErrorCode
} from '../../../src/shared/feedbackShare'
import { sanitizeImage } from '../../feedback-relay/src/images'
import { FeedbackLimiter, limiterKey, sourceIdentity, type LimiterResult, type Window } from '../../feedback-relay/src/limiter'
import type { Env } from './env'
import {
  API_PREFIX,
  ASSET_PREFIX,
  COMMENT_GLOBAL,
  COMMENT_PER_IP,
  COMMENT_PER_SHARE,
  CREATE_GLOBAL,
  CREATE_PER_SENDER,
  MAX_PAGE_REQUEST_BYTES,
  OWNER_PER_IP,
  PUBLIC_API_PREFIX
} from './limits'
import { SHARE_CSS, SHARE_HTML, SHARE_JS } from './page'
import { ShareRoom, pageMediaKey, type RoomCommand, type RoomResult } from './room'

export { FeedbackLimiter, ShareRoom }

export type Deps = { now: () => number; random: (bytes: number) => string }

const defaultDeps: Deps = {
  now: () => Date.now(),
  random: (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' }
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS }
/** 相手の画面の CSP。ライブで元のページを開くため、iframe だけは http(s) のどこでも許す */
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
  'frame-src https: http:', "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join('; ')

function fail(code: ShareErrorCode, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status: SHARE_ERROR_STATUS[code], headers: { ...JSON_HEADERS, ...extra } })
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

class Rejection extends Error {
  constructor(readonly code: ShareErrorCode, readonly headers: Record<string, string> = {}) {
    super(code)
  }
}

export async function handle(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  try {
    if (path === '/' && request.method === 'GET') return Response.redirect('https://ferretade.dev/', 302)
    if (path.startsWith('/s/')) return servePage(request, path)
    if (path.startsWith(ASSET_PREFIX)) return serveAsset(request, path)
    if (path.startsWith(PUBLIC_API_PREFIX)) return await publicApi(request, env, deps, path.slice(PUBLIC_API_PREFIX.length).split('/'))
    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
      // 持ち主の操作はアプリの main からだけ（ブラウザの Origin が付いたものは断る。CORS は出さない）
      if (request.headers.has('origin')) return fail('origin_not_allowed')
      return await ownerApi(request, env, deps, path.slice(API_PREFIX.length).split('/').filter(Boolean))
    }
    return fail('not_found')
  } catch (e) {
    if (e instanceof Rejection) return fail(e.code, e.headers)
    console.error('feedback-share: internal error', e instanceof Error ? e.name : typeof e)
    return fail('internal')
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env)
}

/* ── 相手の画面 ─────────────────────────────────── */

function servePage(request: Request, path: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method_not_allowed', { allow: 'GET' })
  if (!SHARE_ID_PATTERN.test(path.slice('/s/'.length).replace(/\/$/, ''))) return fail('not_found')
  return new Response(request.method === 'HEAD' ? null : SHARE_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY', ...SECURITY_HEADERS }
  })
}

function serveAsset(request: Request, path: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method_not_allowed', { allow: 'GET' })
  const asset = path === '/assets/share.js' ? { body: SHARE_JS, type: 'text/javascript; charset=utf-8' }
    : path === '/assets/share.css' ? { body: SHARE_CSS, type: 'text/css; charset=utf-8' } : null
  if (!asset) return fail('not_found')
  return new Response(request.method === 'HEAD' ? null : asset.body, { headers: { 'content-type': asset.type, 'cache-control': 'public, max-age=300', ...SECURITY_HEADERS } })
}

/* ── 部屋と頻度の上限 ───────────────────────────── */

async function room(env: Env, shareId: string, command: RoomCommand): Promise<RoomResult> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(shareId))
  const res = await stub.fetch(new Request('https://room.internal/', { method: 'POST', body: JSON.stringify(command), headers: { 'content-type': 'application/json' } }))
  if (!res.ok) throw new Error('room failed')
  return (await res.json()) as RoomResult
}

function roomFailure(result: RoomResult): never {
  throw new Rejection(result.ok ? 'internal' : result.code === 'invalid_request' ? 'invalid_request' : result.code)
}

async function ask(env: Env, name: string, op: 'hit' | 'release', windows: readonly Window[], now: number): Promise<LimiterResult> {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(name))
  const res = await stub.fetch(new Request('https://limiter.internal/', { method: 'POST', body: JSON.stringify({ op, windows, now }), headers: { 'content-type': 'application/json' } }))
  if (!res.ok) throw new Error('limiter failed')
  return (await res.json()) as LimiterResult
}

type Check = { name: string; windows: readonly Window[] }

/**
 * 枠を狭い順に1つずつ予約する。断られたらそこで止め、先に取った予約を戻す（断られた要求が広い枠を減らさない。feedback-relay と同じ決まり）。
 * 通れば、あとで戻すための予約の一覧を返す
 */
async function admit(env: Env, checks: readonly Check[], now: number): Promise<Check[]> {
  const taken: Check[] = []
  for (const check of checks) {
    const result = await ask(env, check.name, 'hit', check.windows, now)
    if (!result.allowed) {
      await release(env, taken, now)
      throw new Rejection('rate_limited', { 'retry-after': String(result.retryAfterSec) })
    }
    taken.push(check)
  }
  return taken
}

async function release(env: Env, checks: readonly Check[], now: number): Promise<void> {
  await Promise.allSettled(checks.map((c) => ask(env, c.name, 'release', c.windows, now)))
}

const ipOf = (request: Request) => sourceIdentity(request.headers.get('cf-connecting-ip') ?? 'unknown')

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 本文を上限まで読む。超えたら null（全部は読まない） */
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > max) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

async function readJson(request: Request, max: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) throw new Rejection('invalid_request')
  const raw = await readCapped(request, max)
  if (!raw) throw new Rejection('too_large')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new Rejection('invalid_request')
  }
}

/* ── 相手（ログイン無し）の API ─────────────────────── */

async function publicApi(request: Request, env: Env, deps: Deps, parts: string[]): Promise<Response> {
  const [shareId, section, item] = parts
  if (!shareId || !SHARE_ID_PATTERN.test(shareId)) return fail('not_found')
  const now = deps.now()
  // GET /v1/public/<id>
  if (parts.length === 1) {
    if (request.method !== 'GET') return fail('method_not_allowed', { allow: 'GET' })
    const result = await room(env, shareId, { op: 'public', now })
    if (!result.ok) roomFailure(result)
    return json({ ok: true, share: result.view as Record<string, unknown> })
  }
  // GET /v1/public/<id>/pages/<pid>.<ext>
  if (section === 'pages' && parts.length === 3 && item) {
    if (request.method !== 'GET') return fail('method_not_allowed', { allow: 'GET' })
    const m = /^([0-9a-f]{16})\.(png|jpg)$/.exec(item)
    if (!m) return fail('not_found')
    const result = await room(env, shareId, { op: 'page', pageId: m[1]!, now })
    if (!result.ok) roomFailure(result)
    const page = result.page as SharePage
    if (page.ext !== m[2]) return fail('not_found')
    const object = await env.MEDIA.get(pageMediaKey(shareId, page))
    if (!object?.body) return fail('not_found')
    return new Response(object.body, {
      headers: {
        'content-type': page.ext === 'png' ? 'image/png' : 'image/jpeg', 'cache-control': 'private, max-age=600',
        'content-security-policy': "default-src 'none'; sandbox", ...SECURITY_HEADERS
      }
    })
  }
  // POST /v1/public/<id>/comments
  if (section === 'comments' && parts.length === 2) {
    if (request.method !== 'POST') return fail('method_not_allowed', { allow: 'POST' })
    // この Worker の画面からの送信だけ（ほかのサイトのページから送らせない）
    if (request.headers.get('origin') !== env.PUBLIC_BASE) return fail('origin_not_allowed')
    return addComment(request, env, deps, shareId, now)
  }
  return fail('not_found')
}

async function addComment(request: Request, env: Env, deps: Deps, shareId: string, now: number): Promise<Response> {
  const ip = ipOf(request)
  const perIp = { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-comment-ip', ip), windows: COMMENT_PER_IP }
  // 本文を読む前に IP の枠を取る
  await admit(env, [perIp], now)
  const raw = await readJson(request, SHARE_LIMITS.commentRequestBytes)
  // 人には見えない欄（honeypot）に何か入っていれば、保存せずに成功のふりをする
  if (raw && typeof raw === 'object' && typeof (raw as { website?: unknown }).website === 'string' && (raw as { website: string }).website !== '') {
    return json({ ok: true, id: deps.random(8) }, 201)
  }
  const input = sanitizeCommentInput(raw)
  if ('error' in input) throw new Rejection(input.error === 'invalid' ? 'invalid_request' : input.error)
  const taken = await admit(env, [
    { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-comment-share', shareId), windows: COMMENT_PER_SHARE },
    { name: 'share-comment-global', windows: COMMENT_GLOBAL }
  ], now)
  const id = deps.random(8)
  const result = await room(env, shareId, { op: 'addComment', input, id, now })
  if (!result.ok) {
    // 入らなかった送信で、共有と全体の枠を減らさない（IP の枠は試みとして数えたまま）
    await release(env, taken, now)
    roomFailure(result)
  }
  return json({ ok: true, id }, 201)
}

/* ── 持ち主（アプリ）の API ─────────────────────── */

function bearer(request: Request): string {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')
  if (!m || !OWNER_TOKEN_PATTERN.test(m[1]!)) throw new Rejection('unauthorized')
  return m[1]!
}

async function ownerApi(request: Request, env: Env, deps: Deps, parts: string[]): Promise<Response> {
  const now = deps.now()
  const ip = ipOf(request)
  if (parts.length === 0) {
    if (request.method !== 'POST') return fail('method_not_allowed', { allow: 'POST' })
    return createShare(request, env, deps, ip, now)
  }
  const [shareId, section, item] = parts
  if (!shareId || !SHARE_ID_PATTERN.test(shareId)) return fail('not_found')
  const token = bearer(request)
  await admit(env, [{ name: await limiterKey(env.RATE_LIMIT_SALT, 'share-owner-ip', ip), windows: OWNER_PER_IP }], now)
  const tokenHash = await sha256Hex(token)

  if (parts.length === 1) {
    if (request.method === 'GET') {
      const result = await room(env, shareId, { op: 'snapshot', tokenHash, now })
      if (!result.ok) roomFailure(result)
      return json({ ok: true, share: result.snapshot as Record<string, unknown> })
    }
    if (request.method === 'DELETE') {
      const result = await room(env, shareId, { op: 'destroy', tokenHash })
      if (!result.ok) roomFailure(result)
      return json({ ok: true })
    }
    return fail('method_not_allowed', { allow: 'GET, DELETE' })
  }
  if (section === 'pages' && parts.length === 2) {
    if (request.method !== 'POST') return fail('method_not_allowed', { allow: 'POST' })
    return addPage(request, env, deps, shareId, tokenHash)
  }
  if (section === 'comments' && parts.length === 3 && item && ITEM_ID_PATTERN.test(item)) {
    if (request.method === 'DELETE') {
      const result = await room(env, shareId, { op: 'deleteComment', tokenHash, commentId: item })
      if (!result.ok) roomFailure(result)
      return json({ ok: true })
    }
    if (request.method === 'POST') {
      const body = await readJson(request, 1024) as { status?: unknown }
      const status = body?.status
      if (status !== 'new' && status !== 'imported' && status !== 'rejected') throw new Rejection('invalid_request')
      const result = await room(env, shareId, { op: 'setStatus', tokenHash, commentId: item, status })
      if (!result.ok) roomFailure(result)
      return json({ ok: true })
    }
    return fail('method_not_allowed', { allow: 'POST, DELETE' })
  }
  return fail('not_found')
}

async function createShare(request: Request, env: Env, deps: Deps, ip: string, now: number): Promise<Response> {
  const body = await readJson(request, 4096) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw new Rejection('invalid_request')
  const title = cleanText(body.title ?? '', SHARE_LIMITS.titleChars)
  if (title === null) throw new Rejection('too_long')
  const installId = typeof body.installId === 'string' && /^[0-9a-f-]{36}$/i.test(body.installId) ? body.installId : null
  const days = typeof body.days === 'number' && Number.isInteger(body.days) && body.days >= 1 && body.days <= SHARE_LIMITS.maxDays ? body.days : SHARE_LIMITS.defaultDays
  await admit(env, [
    { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-create-ip', ip), windows: CREATE_PER_SENDER },
    ...(installId ? [{ name: await limiterKey(env.RATE_LIMIT_SALT, 'share-create-install', installId), windows: CREATE_PER_SENDER }] : []),
    { name: 'share-create-global', windows: CREATE_GLOBAL }
  ], now)
  const id = deps.random(16)
  const ownerToken = deps.random(32)
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + days * 24 * 60 * 60 * 1000).toISOString()
  const result = await room(env, id, {
    op: 'init',
    meta: { id, title, createdAt, expiresAt, showOthers: body.showOthers === true, tokenHash: await sha256Hex(ownerToken), pages: [], received: 0 }
  })
  if (!result.ok) roomFailure(result)
  return json({ ok: true, id, ownerToken, url: shareUrl(id, env.PUBLIC_BASE), expiresAt }, 201)
}

async function addPage(request: Request, env: Env, deps: Deps, shareId: string, tokenHash: string): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new Rejection('invalid_request')
  const raw = await readCapped(request, MAX_PAGE_REQUEST_BYTES)
  if (!raw) throw new Rejection('too_large')
  let form: FormData
  try {
    form = await new Request('https://share.internal/', { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData()
  } catch {
    throw new Rejection('invalid_request')
  }
  const fields: string[] = []
  form.forEach((_value, key) => { fields.push(key) })
  if (fields.some((k) => k !== 'meta' && k !== 'image')) throw new Rejection('invalid_request')
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(String(form.get('meta') ?? ''))
  } catch {
    throw new Rejection('invalid_request')
  }
  const url = cleanUrl(meta.url)
  const title = cleanText(meta.title ?? '', SHARE_LIMITS.pageTitleChars)
  const size = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 20_000
  if (!url || title === null || !size(meta.width) || !size(meta.height) || (meta.viewport !== 'desktop' && meta.viewport !== 'mobile')) throw new Rejection('invalid_request')
  const file = form.get('image')
  if (!file || typeof file === 'string') throw new Rejection('invalid_request')
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer())
  if (bytes.byteLength > SHARE_LIMITS.imageBytes) throw new Rejection('too_large')
  const image = sanitizeImage(bytes)
  if (!image) throw new Rejection('bad_image')
  const page: SharePage = { id: deps.random(8), url, title, viewport: meta.viewport, width: meta.width as number, height: meta.height as number, ext: image.ext }
  // 静止画を推測できない鍵で置いてから部屋に足す（持ち主の確認と数の上限は部屋で行う）。部屋が断ったら置いた静止画を消す
  const key = pageMediaKey(shareId, page)
  await env.MEDIA.put(key, image.bytes, { httpMetadata: { contentType: image.contentType, cacheControl: 'private, max-age=600' } })
  const result = await room(env, shareId, { op: 'addPage', tokenHash, page }).catch((e: unknown) => {
    void env.MEDIA.delete(key).catch(() => undefined)
    throw e
  })
  if (!result.ok) {
    await env.MEDIA.delete(key).catch(() => undefined)
    roomFailure(result)
  }
  return json({ ok: true, page: page as unknown as Record<string, unknown> }, 201)
}
