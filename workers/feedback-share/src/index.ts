/**
 * ログイン無しで誰でも指摘を送れる共有リンク（Cloudflare Worker）。仕様の正本は src/shared/feedbackShare.ts、手順は README.md。
 *
 * 持ち主（Ferret のアプリの main。Origin の付いた要求は断る。トークンは Authorization: Bearer）:
 *   POST   /v1/shares                                共有を作る → { id, ownerToken, url, expiresAt }
 *   GET    /v1/shares/<id>                           中身と届いた録画の一覧
 *   PATCH  /v1/shares/<id>                           題名・ページ・メモ・パスワードを変える
 *   DELETE /v1/shares/<id>                           共有を消す（録画も）
 *   POST   /v1/shares/<id>/recordings/<rid>          録画の状態（取り込んだ・断った）
 *   DELETE /v1/shares/<id>/recordings/<rid>          録画を消す
 *   GET    /v1/shares/<id>/recordings/<rid>/<file>   録画（media）・記録（events.json）・サムネイル（thumb.jpg）
 * 相手（ログイン無し。この Worker が配る画面から同じオリジンで。パスワードのある共有は、確かめたあとのセッションの cookie が要る）:
 *   GET    /s/<id>                                   画面（静的な HTML。中身は JS が下の API から読む）
 *   GET    /v1/public/<id>                           中身（パスワードのある共有で cookie が無ければ locked とソルトだけ）
 *   POST   /v1/public/<id>/unlock                    パスワードの証明（shareCrypto.ts）を確かめ、セッションの cookie を出す
 *   POST   /v1/public/<id>/recordings                録画を始める（大きさ・形式を宣言して枠を取る）
 *   PUT    /v1/public/<id>/recordings/<rid>/parts/<n> 録画を分けて送る（R2 の multipart）
 *   POST   /v1/public/<id>/recordings/<rid>/complete 送り終えた（文字の指摘・書き込みの記録・サムネイル）
 *   POST   /v1/public/<id>/recordings/<rid>/abort    取りやめる
 *   GET    /v1/public/<id>/recordings/<rid>/media|thumb.jpg  届いた録画とサムネイル（同じリンクを開いた人は誰でも見られる）
 *
 * 守り:
 *   - shareId 128 bit・ownerToken 256 bit は推測できない乱数。トークンはハッシュだけを部屋に置き、URL のクエリに載せない
 *   - パスワードはサーバーへ届かない。相手のブラウザが PBKDF2 で作った証明の SHA-256 を部屋の値と比べる。試みは IP と共有の組・共有・IP ごとに数える。
 *     合えば HttpOnly・Secure・SameSite=Strict の cookie（12時間。共有のソルトと期限の HMAC）を出す。パスワードを変えると古い cookie は効かない
 *   - メモはパスワードのある共有では暗号文だけ（アプリが暗号化し、相手の画面が手元で復号する）
 *   - 画面は厳しい CSP（自分のスクリプトだけ。外の CDN なし）・noindex・Referrer を送らない（ライブで開く iframe の先へ共有の URL を漏らさない）
 *   - 送る値は許可リストで確かめ、録画は宣言した大きさで予約し（1本 300MB・共有の合計 3GB）、順に1回ずつ受け、最初の回の先頭のバイトで形式を確かめる
 *   - 頻度の上限は狭い順に予約し、断られたら先に取った予約を戻す（feedback-relay と同じ決まり）。honeypot に何か入っていれば成功のふりをして何もしない
 *   - 期限は7日。部屋の alarm が録画と記録を消す（R2 のライフサイクルでも 8 日で消える。README）
 *   - 失敗は短い code だけを返し、IP・本文・トークン・メモはログに出さない
 */
import {
  ITEM_ID_PATTERN,
  OWNER_TOKEN_PATTERN,
  PROOF_PATTERN,
  SHARE_ERROR_STATUS,
  SHARE_ID_PATTERN,
  SHARE_LIMITS,
  SHARE_MEDIA_TYPES,
  cleanText,
  mediaMatches,
  sanitizeAuthVerifier,
  sanitizeEventsFile,
  sanitizeMemo,
  sanitizeNotes,
  sanitizeRecordingStart,
  sanitizeShareUrls,
  shareUrl,
  type SharePublicView,
  type ShareErrorCode,
  type ShareRecording
} from '../../../src/shared/feedbackShare'
import { fromBase64, sha256Hex, toHex } from '../../../src/shared/shareCrypto'
import { sanitizeImage } from '../../feedback-relay/src/images'
import { FeedbackLimiter, limiterKey, sourceIdentity, type LimiterResult, type Window } from '../../feedback-relay/src/limiter'
import type { Env } from './env'
import {
  API_PREFIX,
  ASSET_PREFIX,
  CREATE_GLOBAL,
  CREATE_PER_SENDER,
  OWNER_PER_IP,
  PUBLIC_API_PREFIX,
  RECORDING_GLOBAL,
  RECORDING_PER_IP,
  RECORDING_PER_SHARE,
  SESSION_MS,
  UNLOCK_PER_IP,
  UNLOCK_PER_IP_SHARE,
  UNLOCK_PER_SHARE
} from './limits'
import { SHARE_CSS, SHARE_JS } from './generated'
import { SHARE_HTML } from './page'
import { ShareRoom, eventsKey, mediaKey, thumbKey, type RoomCommand, type RoomResult } from './room'

export { FeedbackLimiter, ShareRoom }

export type Deps = { now: () => number; random: (bytes: number) => string }

const defaultDeps: Deps = {
  now: () => Date.now(),
  random: (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' }
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS }
/**
 * 相手の画面の CSP。ライブで元のページを開くため、iframe だけは http(s) のどこでも許す。
 * 録画（blob:）とサムネイル（data:・blob:）、届いた録画の再生（self）を許す
 */
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
  'frame-src https: http:', "worker-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join('; ')
/** 画面が使ってよいブラウザの機能（画面の録画・マイク）。iframe で開いたページには渡さない */
const PERMISSIONS_POLICY = 'display-capture=(self), microphone=(self), camera=(), geolocation=(), payment=(), usb=()'

function fail(code: ShareErrorCode, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status: SHARE_ERROR_STATUS[code], headers: { ...JSON_HEADERS, ...extra } })
}

function json(body: Record<string, unknown>, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } })
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
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY',
      'permissions-policy': PERMISSIONS_POLICY, ...SECURITY_HEADERS
    }
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
  throw new Rejection(result.ok ? 'internal' : result.code)
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

async function readJson(request: Request, max: number): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) throw new Rejection('invalid_request')
  const raw = await readCapped(request, max)
  if (!raw) throw new Rejection('too_large')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new Rejection('invalid_request')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Rejection('invalid_request')
  return value as Record<string, unknown>
}

/* ── パスワードのあとのセッション ─────────────────────── */

const cookieName = (shareId: string) => `__Host-fs-${shareId}`

async function sessionMac(env: Env, shareId: string, salt: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RATE_LIMIT_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`share-session\0${shareId}\0${salt}\0${exp}`))))
}

/** パスワードのある共有で、確かめたあとの cookie を持っているか（ソルトが変わる＝パスワードを変えると効かなくなる） */
async function hasSession(request: Request, env: Env, shareId: string, salt: string, now: number): Promise<boolean> {
  const cookies = request.headers.get('cookie') ?? ''
  const name = cookieName(shareId)
  const value = cookies.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(value)
  if (!m) return false
  const exp = Number(m[1])
  if (!(exp > now) || exp > now + SESSION_MS + 60_000) return false
  const expected = await sessionMac(env, shareId, salt, exp)
  // 定時間で比べる
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2]!.charCodeAt(i)
  return diff === 0
}

/** 共有が開けるか（期限内で、パスワードがあれば確かめ済み）。開けなければ locked の値 */
async function gate(request: Request, env: Env, shareId: string, now: number): Promise<{ open: true } | { open: false; salt: string; iterations: number }> {
  const result = await room(env, shareId, { op: 'gate', now })
  if (!result.ok) roomFailure(result)
  if (!result.protected) return { open: true }
  const salt = result.salt as string
  if (await hasSession(request, env, shareId, salt, now)) return { open: true }
  return { open: false, salt, iterations: result.iterations as number }
}

async function requireOpen(request: Request, env: Env, shareId: string, now: number): Promise<void> {
  const g = await gate(request, env, shareId, now)
  if (!g.open) throw new Rejection('locked')
}

/** この Worker の画面からの送信だけ（ほかのサイトのページから送らせない） */
function requireSameOrigin(request: Request, env: Env): void {
  if (request.headers.get('origin') !== env.PUBLIC_BASE) throw new Rejection('origin_not_allowed')
}

/* ── 相手（ログイン無し）の API ─────────────────────── */

async function publicApi(request: Request, env: Env, deps: Deps, parts: string[]): Promise<Response> {
  const [shareId, section, recId, action, partNo] = parts
  if (!shareId || !SHARE_ID_PATTERN.test(shareId)) return fail('not_found')
  const now = deps.now()
  // GET /v1/public/<id>
  if (parts.length === 1) {
    if (request.method !== 'GET') return fail('method_not_allowed', { allow: 'GET' })
    const g = await gate(request, env, shareId, now)
    if (!g.open) return json({ ok: true, share: { locked: true, salt: g.salt, iterations: g.iterations } satisfies SharePublicView })
    const result = await room(env, shareId, { op: 'public', now })
    if (!result.ok) roomFailure(result)
    return json({ ok: true, share: result.view as Record<string, unknown> })
  }
  if (section === 'unlock' && parts.length === 2) {
    if (request.method !== 'POST') return fail('method_not_allowed', { allow: 'POST' })
    requireSameOrigin(request, env)
    return unlock(request, env, shareId, now)
  }
  if (section !== 'recordings') return fail('not_found')
  if (parts.length === 2) {
    if (request.method !== 'POST') return fail('method_not_allowed', { allow: 'POST' })
    requireSameOrigin(request, env)
    await requireOpen(request, env, shareId, now)
    return startRecording(request, env, deps, shareId, now)
  }
  if (!recId || !ITEM_ID_PATTERN.test(recId)) return fail('not_found')
  if (parts.length === 4 && (action === 'media' || action === 'thumb.jpg')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method_not_allowed', { allow: 'GET' })
    await requireOpen(request, env, shareId, now)
    return serveRecordingFile(request, env, shareId, recId, action, now)
  }
  if (request.method === 'POST' && parts.length === 4 && (action === 'complete' || action === 'abort')) {
    requireSameOrigin(request, env)
    await requireOpen(request, env, shareId, now)
    return action === 'complete' ? completeRecording(request, env, shareId, recId, now) : abortRecording(env, shareId, recId)
  }
  if (request.method === 'PUT' && parts.length === 5 && action === 'parts' && partNo && /^[1-9]\d{0,3}$/.test(partNo)) {
    requireSameOrigin(request, env)
    await requireOpen(request, env, shareId, now)
    return uploadPart(request, env, shareId, recId, Number(partNo), now)
  }
  return fail('not_found')
}

async function unlock(request: Request, env: Env, shareId: string, now: number): Promise<Response> {
  const ip = ipOf(request)
  // 本文を読む前に、総当たりの枠を取る（外れたものも合ったものも数える）
  await admit(env, [
    { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-unlock-ip-share', `${ip}\0${shareId}`), windows: UNLOCK_PER_IP_SHARE },
    { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-unlock-ip', ip), windows: UNLOCK_PER_IP },
    { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-unlock-share', shareId), windows: UNLOCK_PER_SHARE }
  ], now)
  const body = await readJson(request, 1024)
  if (typeof body.proof !== 'string' || !PROOF_PATTERN.test(body.proof)) throw new Rejection('invalid_request')
  const gateResult = await room(env, shareId, { op: 'gate', now })
  if (!gateResult.ok) roomFailure(gateResult)
  if (!gateResult.protected) return json({ ok: true })
  const verified = await room(env, shareId, { op: 'verify', proof: body.proof, now })
  if (!verified.ok) roomFailure(verified)
  const exp = now + SESSION_MS
  const mac = await sessionMac(env, shareId, gateResult.salt as string, exp)
  return json({ ok: true }, 200, {
    'set-cookie': `${cookieName(shareId)}=${exp}.${mac}; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`
  })
}

async function startRecording(request: Request, env: Env, deps: Deps, shareId: string, now: number): Promise<Response> {
  const ip = ipOf(request)
  const perIp = { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-rec-ip', ip), windows: RECORDING_PER_IP }
  await admit(env, [perIp], now)
  const raw = await readJson(request, 4096)
  // 人には見えない欄（honeypot）に何か入っていれば、受け付けたふりをして何もしない
  if (typeof raw.website === 'string' && raw.website !== '') {
    return json({ ok: true, id: deps.random(8), parts: 0, partBytes: SHARE_LIMITS.partBytes, decoy: true }, 201)
  }
  const start = sanitizeRecordingStart(raw)
  if ('error' in start) throw new Rejection(start.error === 'invalid' ? 'invalid_request' : start.error)
  const taken = await admit(env, [
    { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-rec-share', shareId), windows: RECORDING_PER_SHARE },
    { name: 'share-rec-global', windows: RECORDING_GLOBAL }
  ], now)
  const id = deps.random(8)
  const result = await room(env, shareId, { op: 'start', start, id, now })
  if (!result.ok) {
    // 入らなかった録画で、共有と全体の枠を減らさない（IP の枠は試みとして数えたまま）
    await release(env, taken, now)
    roomFailure(result)
  }
  if (!result.notesOnly) {
    const upload = await env.MEDIA.createMultipartUpload(result.key as string, { httpMetadata: { contentType: start.mime! } })
    const attached = await room(env, shareId, { op: 'attach', id, uploadId: upload.uploadId })
    if (!attached.ok) {
      await upload.abort().catch(() => undefined)
      roomFailure(attached)
    }
  }
  return json({ ok: true, id, parts: result.parts as number, partBytes: SHARE_LIMITS.partBytes }, 201)
}

async function uploadPart(request: Request, env: Env, shareId: string, recId: string, partNumber: number, now: number): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '-1')
  if (!(declared > 0) || declared > SHARE_LIMITS.partBytes) throw new Rejection('too_large')
  const check = await room(env, shareId, { op: 'part', id: recId, partNumber, size: declared, now })
  if (!check.ok) roomFailure(check)
  const bytes = await readCapped(request, SHARE_LIMITS.partBytes)
  if (!bytes || bytes.byteLength !== declared) throw new Rejection('invalid_request')
  // 最初の回の先頭で、宣言した形式（webm / mp4）かを確かめる。違えば取りやめる
  if (check.first && !mediaMatches(check.mime as keyof typeof SHARE_MEDIA_TYPES, bytes.subarray(0, 16))) {
    await abortRecording(env, shareId, recId).catch(() => undefined)
    throw new Rejection('bad_media')
  }
  const upload = env.MEDIA.resumeMultipartUpload(check.key as string, check.uploadId as string)
  const part = await upload.uploadPart(partNumber, bytes)
  const done = await room(env, shareId, { op: 'partDone', id: recId, partNumber, etag: part.etag })
  if (!done.ok) roomFailure(done)
  return json({ ok: true })
}

async function completeRecording(request: Request, env: Env, shareId: string, recId: string, now: number): Promise<Response> {
  const body = await readJson(request, SHARE_LIMITS.eventsBytes + Math.ceil(SHARE_LIMITS.thumbnailBytes * 1.4) + 64 * 1024)
  const check = await room(env, shareId, { op: 'finishCheck', id: recId, now })
  if (!check.ok) roomFailure(check)
  const durationMs = check.durationMs as number
  const notes = sanitizeNotes(body.notes, durationMs)
  if (!notes) throw new Rejection('invalid_request')
  const events = body.events === undefined ? null : sanitizeEventsFile(body.events, durationMs)
  if (body.events !== undefined && !events) throw new Rejection('invalid_request')
  let thumb: Uint8Array | null = null
  if (typeof body.thumbnail === 'string') {
    if (body.thumbnail.length > Math.ceil(SHARE_LIMITS.thumbnailBytes * 1.4)) throw new Rejection('too_large')
    let raw: Uint8Array
    try {
      raw = fromBase64(body.thumbnail)
    } catch {
      throw new Rejection('bad_image')
    }
    const image = sanitizeImage(raw)
    if (!image || image.ext !== 'jpg' || image.bytes.byteLength > SHARE_LIMITS.thumbnailBytes) throw new Rejection('bad_image')
    thumb = image.bytes
  }
  if (check.uploadId) {
    await env.MEDIA.resumeMultipartUpload(check.key as string, check.uploadId as string).complete(check.parts as Array<{ partNumber: number; etag: string }>)
  }
  if (events) await env.MEDIA.put(eventsKey(shareId, recId), JSON.stringify(events), { httpMetadata: { contentType: 'application/json' } })
  if (thumb) await env.MEDIA.put(thumbKey(shareId, recId), thumb, { httpMetadata: { contentType: 'image/jpeg' } })
  const ready = await room(env, shareId, { op: 'ready', id: recId, notes, hasThumbnail: !!thumb })
  if (!ready.ok) roomFailure(ready)
  return json({ ok: true, id: recId })
}

async function abortRecording(env: Env, shareId: string, recId: string): Promise<Response> {
  const result = await room(env, shareId, { op: 'abort', id: recId })
  if (!result.ok) roomFailure(result)
  if (result.uploadId) await env.MEDIA.resumeMultipartUpload(result.key as string, result.uploadId as string).abort().catch(() => undefined)
  return json({ ok: true })
}

/** 録画（Range に応える）・サムネイル・記録を返す。owner は持ち主のトークンのハッシュ（断ったものも返す） */
async function serveRecordingFile(request: Request, env: Env, shareId: string, recId: string, file: 'media' | 'thumb.jpg' | 'events.json', now: number, owner?: string): Promise<Response> {
  const result = await room(env, shareId, { op: 'media', id: recId, now, ...(owner ? { owner } : {}) })
  if (!result.ok) roomFailure(result)
  const rec = result.recording as ShareRecording
  const sandbox = { 'content-security-policy': "default-src 'none'; sandbox", ...SECURITY_HEADERS }
  if (file === 'thumb.jpg' || file === 'events.json') {
    if (file === 'thumb.jpg' && !rec.hasThumbnail) return fail('not_found')
    const object = await env.MEDIA.get(file === 'thumb.jpg' ? thumbKey(shareId, recId) : eventsKey(shareId, recId))
    if (!object?.body) return fail('not_found')
    return new Response(request.method === 'HEAD' ? null : object.body, {
      headers: { 'content-type': file === 'thumb.jpg' ? 'image/jpeg' : 'application/json', 'cache-control': 'private, max-age=600', ...sandbox }
    })
  }
  if (!rec.mime) return fail('not_found')
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range && range[2] ? Number(range[2]) : rec.bytes - 1
  if (range && (start >= rec.bytes || end < start)) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${rec.bytes}`, ...sandbox } })
  const length = Math.min(end, rec.bytes - 1) - start + 1
  const object = await env.MEDIA.get(mediaKey(shareId, recId), range ? { range: { offset: start, length } } : undefined)
  if (!object?.body) return fail('not_found')
  const headers: Record<string, string> = {
    'content-type': rec.mime, 'accept-ranges': 'bytes', 'content-length': String(range ? length : object.size), 'cache-control': 'private, max-age=600', ...sandbox
  }
  if (range) headers['content-range'] = `bytes ${start}-${start + length - 1}/${object.size}`
  return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers })
}

/* ── 持ち主（アプリ）の API ─────────────────────── */

function bearer(request: Request): string {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')
  if (!m || !OWNER_TOKEN_PATTERN.test(m[1]!)) throw new Rejection('unauthorized')
  return m[1]!
}

/** 作る・変えるときの値（題名・ページ・メモ・パスワードの確認の値）。undefined は「変えない」 */
function sharePatch(body: Record<string, unknown>) {
  const title = body.title === undefined ? undefined : cleanText(body.title, SHARE_LIMITS.titleChars)
  if (title === null) throw new Rejection('too_long')
  const urls = body.urls === undefined ? undefined : sanitizeShareUrls(body.urls)
  if (urls === null) throw new Rejection('invalid_request')
  const memo = body.memo === undefined ? undefined : sanitizeMemo(body.memo)
  if (body.memo !== undefined && memo === undefined) throw new Rejection('invalid_request')
  const auth = body.auth === undefined ? undefined : sanitizeAuthVerifier(body.auth)
  if (body.auth !== undefined && auth === undefined) throw new Rejection('invalid_request')
  return { ...(title !== undefined ? { title } : {}), ...(urls !== undefined ? { urls } : {}), ...(memo !== undefined ? { memo } : {}), ...(auth !== undefined ? { auth } : {}) }
}

async function ownerApi(request: Request, env: Env, deps: Deps, parts: string[]): Promise<Response> {
  const now = deps.now()
  const ip = ipOf(request)
  if (parts.length === 0) {
    if (request.method !== 'POST') return fail('method_not_allowed', { allow: 'POST' })
    return createShare(request, env, deps, ip, now)
  }
  const [shareId, section, recId, file] = parts
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
    if (request.method === 'PATCH') {
      const patch = sharePatch(await readJson(request, 32 * 1024))
      if (patch.urls?.length === 0) throw new Rejection('invalid_request')
      const result = await room(env, shareId, { op: 'update', tokenHash, patch })
      if (!result.ok) roomFailure(result)
      return json({ ok: true })
    }
    if (request.method === 'DELETE') {
      const result = await room(env, shareId, { op: 'destroy', tokenHash })
      if (!result.ok) roomFailure(result)
      return json({ ok: true })
    }
    return fail('method_not_allowed', { allow: 'GET, PATCH, DELETE' })
  }
  if (section !== 'recordings' || !recId || !ITEM_ID_PATTERN.test(recId)) return fail('not_found')
  if (parts.length === 4 && (file === 'media' || file === 'events.json' || file === 'thumb.jpg') && request.method === 'GET') {
    return serveRecordingFile(request, env, shareId, recId, file, now, tokenHash)
  }
  if (parts.length === 3) {
    if (request.method === 'DELETE') {
      const result = await room(env, shareId, { op: 'deleteRecording', tokenHash, id: recId })
      if (!result.ok) roomFailure(result)
      return json({ ok: true })
    }
    if (request.method === 'POST') {
      const body = await readJson(request, 1024)
      const status = body.status
      if (status !== 'new' && status !== 'imported' && status !== 'rejected') throw new Rejection('invalid_request')
      const result = await room(env, shareId, { op: 'setStatus', tokenHash, id: recId, status })
      if (!result.ok) roomFailure(result)
      return json({ ok: true })
    }
    return fail('method_not_allowed', { allow: 'POST, DELETE' })
  }
  return fail('not_found')
}

async function createShare(request: Request, env: Env, deps: Deps, ip: string, now: number): Promise<Response> {
  const body = await readJson(request, 32 * 1024)
  const patch = sharePatch(body)
  if (!patch.urls) throw new Rejection('invalid_request')
  // 暗号化したメモはパスワードと一緒でなければ受けない（開けないメモを作らない）
  if (patch.memo?.kind === 'sealed' && !patch.auth) throw new Rejection('invalid_request')
  const installId = typeof body.installId === 'string' && /^[0-9a-f-]{36}$/i.test(body.installId) ? body.installId : null
  await admit(env, [
    { name: await limiterKey(env.RATE_LIMIT_SALT, 'share-create-ip', ip), windows: CREATE_PER_SENDER },
    ...(installId ? [{ name: await limiterKey(env.RATE_LIMIT_SALT, 'share-create-install', installId), windows: CREATE_PER_SENDER }] : []),
    { name: 'share-create-global', windows: CREATE_GLOBAL }
  ], now)
  const id = deps.random(16)
  const ownerToken = deps.random(32)
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + SHARE_LIMITS.days * 24 * 60 * 60 * 1000).toISOString()
  const result = await room(env, id, {
    op: 'init',
    meta: {
      id, title: patch.title ?? patch.urls[0]!.title, createdAt, expiresAt, urls: patch.urls,
      ...(patch.memo ? { memo: patch.memo } : {}), ...(patch.auth ? { auth: patch.auth } : {}),
      tokenHash: await sha256Hex(ownerToken), received: 0, bytes: 0
    }
  })
  if (!result.ok) roomFailure(result)
  return json({ ok: true, id, ownerToken, url: shareUrl(id, env.PUBLIC_BASE), expiresAt }, 201)
}
