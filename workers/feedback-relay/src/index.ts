/**
 * Ferret のアプリから匿名で送られたフィードバックを、GitHub の Issue にする中継（Cloudflare Worker）。
 *
 *   POST /v1/issues            multipart/form-data → JapanMarketing-Dev/ferret に Issue を作る
 *   GET  /v1/media/<id>.<ext>  Issue に貼った静止画を返す（R2 の非公開のバケットから）
 *
 * 守り（仕様は limits.ts、手順は README.md）:
 *   - Origin が付いた送信（ブラウザ）は断る。CORS は出さない（アプリの main から送る）
 *   - 大きさ・フィールド・種類の許可リスト。画像は中身で PNG / JPEG を確かめ、メタデータを取り除く
 *   - 本文と題名の鍵・トークン・メール・ホームのパスを伏せ字にする
 *   - 本文を読む前に、IP ごとの試みの上限と、IP の送信の上限を確かめる（security-3 [4]）
 *   - IP とインストール ID ごとの頻度の上限、全体の上限（狭い順に予約し、断られたら広い枠に触れない・予約を戻す。security-3 [3]）
 *   - 同じ内容の連投の拒否。画像・Issue を作る前に内容の鍵を1回の呼び出しで取る（security-3 [7]）。Durable Object で数える
 *   - 失敗の理由は短い code だけを返す。IP・本文・トークンはログにも出さず、IP は保存しない（HMAC で数えるだけ）
 */
import type { Env } from './env'
import { buildIssue, createIssue } from './github'
import { sanitizeImage, type SanitizedImage } from './images'
import { askLimiter, limiterKey, FeedbackLimiter, type LimiterResult, type Window } from './limiter'
import {
  ALLOWED_FIELDS,
  ARCHES,
  DUPLICATE_WINDOW_MS,
  ERROR_STATUS,
  GLOBAL_LIMITS,
  ISSUES_PATH,
  ATTEMPT_LIMITS,
  KINDS,
  MAX_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_REQUEST_BYTES,
  MAX_TITLE_CHARS,
  MEDIA_PATH_PREFIX,
  PER_SENDER_LIMITS,
  PLATFORMS,
  type ErrorCode
} from './limits'

export { FeedbackLimiter }

export type Deps = { fetch: typeof fetch; now: () => number }

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function fail(code: ErrorCode, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status: ERROR_STATUS[code], headers: { ...JSON_HEADERS, ...extraHeaders } })
}

class Rejection extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
  }
}

export async function handle(request: Request, env: Env, deps: Deps = { fetch: (...a) => fetch(...a), now: () => Date.now() }): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname.startsWith(MEDIA_PATH_PREFIX)) return await serveMedia(request, env, url.pathname)
    if (url.pathname !== ISSUES_PATH) return fail('not_found')
    // ブラウザからの送信（Origin が付く）は断る。アプリの main プロセスからの送信には付かない
    if (request.headers.has('origin')) return fail('origin_not_allowed')
    if (request.method !== 'POST') return fail('method_not_allowed', { allow: 'POST' })
    return await submit(request, env, deps)
  } catch (e) {
    if (e instanceof Rejection) return fail(e.code)
    // 中身（本文・IP・トークン）は出さず、種類だけを残す
    console.error('feedback-relay: internal error', e instanceof Error ? e.name : typeof e)
    return fail('internal')
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env)
}

/* ── 受け付け ─────────────────────────────────────────── */

type Submission = {
  kind: 'bug' | 'enhancement'
  title: string
  body: string
  appVersion: string
  platform?: string
  arch?: string
  osRelease?: string
  installId?: string
  images: SanitizedImage[]
}

async function submit(request: Request, env: Env, deps: Deps): Promise<Response> {
  // 本文（最大 8MB）を読む・multipart を解く・画像を確かめるより前に、IP だけで決められる上限を確かめる（security-3 [4]）。
  // IP・インストール ID はそのまま使わず HMAC にする。保存もしない
  const now = deps.now()
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const ipKey = await limiterKey(env.RATE_LIMIT_SALT, 'ip', ip)
  // 試みの数（形の悪いもの・断ったものも数える）。Issue になった数の枠（ip・全体）とは別
  const attempt = await askLimiter(env, await limiterKey(env.RATE_LIMIT_SALT, 'attempt', ip), 'hit', ATTEMPT_LIMITS, now)
  if (!attempt.allowed) return fail('rate_limited', { 'retry-after': String(attempt.retryAfterSec) })
  // 送信の枠を使い切った IP は、本文を読まずに断る（数えない）
  const ipPeek = await askLimiter(env, ipKey, 'peek', PER_SENDER_LIMITS, now)
  if (!ipPeek.allowed) return fail('rate_limited', { 'retry-after': String(ipPeek.retryAfterSec) })

  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) return fail('unsupported_media_type')
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_REQUEST_BYTES) return fail('too_large')
  const raw = await readCapped(request, MAX_REQUEST_BYTES)
  if (!raw) return fail('too_large')

  let form: FormData
  try {
    form = await new Request('https://relay.internal/', { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData()
  } catch {
    return fail('invalid_request')
  }
  const s = await parseSubmission(form)

  // 頻度の上限。インストール ID は任意（送らない選択もできる）。無ければ IP と全体だけで数える
  const checks = [
    { name: ipKey, windows: PER_SENDER_LIMITS },
    ...(s.installId ? [{ name: await limiterKey(env.RATE_LIMIT_SALT, 'install', s.installId), windows: PER_SENDER_LIMITS }] : []),
    { name: 'global', windows: GLOBAL_LIMITS }
  ]
  const admission = await admit(env, checks, now)
  if (!admission.allowed) return fail('rate_limited', { 'retry-after': String(admission.retryAfterSec) })

  // 同じ題名と本文の連投（送り主を問わない）。確かめると取るを1回で行い、同時に来た同じ内容は1件だけが先へ進む（security-3 [7]）
  const dupKey = await limiterKey(env.RATE_LIMIT_SALT, 'dup', `${s.title.toLowerCase()}\n${s.body.replace(/\s+/g, ' ').trim().toLowerCase()}`)
  const dupWindow = [{ windowMs: DUPLICATE_WINDOW_MS, max: 1 }]
  if (!(await askLimiter(env, dupKey, 'hit', dupWindow, now)).allowed) return fail('duplicate')

  // 画像を推測できない名前で置く。Issue を作れなければ消す
  const keys: string[] = []
  try {
    for (const image of s.images) {
      const key = `v1/${randomHex(16)}.${image.ext}`
      await env.MEDIA.put(key, image.bytes, { httpMetadata: { contentType: image.contentType, cacheControl: 'public, max-age=31536000, immutable' } })
      keys.push(key)
    }
    const issue = buildIssue({ ...s, imageUrls: keys.map((k) => `${env.PUBLIC_BASE}${MEDIA_PATH_PREFIX}${k.slice('v1/'.length)}`) })
    const created = await createIssue(deps.fetch, env.GITHUB_TOKEN, env.GITHUB_REPO, issue)
    if (!created) throw new Rejection('upstream_failed')
    return new Response(JSON.stringify({ ok: true, issue: created.number, url: created.url }), { status: 201, headers: JSON_HEADERS })
  } catch (e) {
    // Issue を作れなかった：置いた画像を消し、内容の鍵を戻す（同じ内容をあとで送り直せる）
    await Promise.allSettled([...keys.map((k) => env.MEDIA.delete(k)), askLimiter(env, dupKey, 'release', dupWindow, now)])
    if (e instanceof Rejection) throw e
    throw new Rejection('upstream_failed')
  }
}

/**
 * 頻度の枠を、狭い順（IP → インストール ID → 全体）に1つずつ予約する（security-3 [3]）。
 * 断られたらそこで止め、広い枠（全体）には触れない。先に取った予約は戻す（断られた要求が、ほかの枠を減らさない）
 */
async function admit(env: Env, checks: ReadonlyArray<{ name: string; windows: readonly Window[] }>, now: number): Promise<LimiterResult> {
  const taken: Array<{ name: string; windows: readonly Window[] }> = []
  for (const c of checks) {
    const r = await askLimiter(env, c.name, 'hit', c.windows, now)
    if (!r.allowed) {
      await Promise.allSettled(taken.map((t) => askLimiter(env, t.name, 'release', t.windows, now)))
      return r
    }
    taken.push(c)
  }
  return { allowed: true, retryAfterSec: 0 }
}

/** 本文を上限まで読む。超えたら null（Content-Length が無い・偽りのときも、ここで止まる） */
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** フィールドを許可リストで確かめる。違えば Rejection（code だけ） */
export async function parseSubmission(form: FormData): Promise<Submission> {
  let unknown = false
  form.forEach((_value, name) => {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(name)) unknown = true
  })
  if (unknown) throw new Rejection('unknown_field')
  const text = (name: string, code: ErrorCode, required = true): string | undefined => {
    const values = form.getAll(name)
    if (values.length === 0 && !required) return undefined
    if (values.length !== 1 || typeof values[0] !== 'string') throw new Rejection(code)
    return values[0]
  }

  const kind = text('kind', 'invalid_kind')!
  if (!(KINDS as readonly string[]).includes(kind)) throw new Rejection('invalid_kind')

  const title = text('title', 'invalid_title')!.trim()
  if (!title || [...title].length > MAX_TITLE_CHARS || /[\r\n]/.test(title) || CONTROL_CHARS.test(title)) throw new Rejection('invalid_title')

  const body = text('body', 'invalid_body')!.replace(/\r\n?/g, '\n')
  if (!body.trim() || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES || CONTROL_CHARS.test(body)) throw new Rejection('invalid_body')

  // appVersion だけが必須。環境情報（platform・arch・osRelease）とインストール ID は、利用者が外せば送られない
  const appVersion = text('appVersion', 'invalid_meta')!
  const platform = text('platform', 'invalid_meta', false)
  const arch = text('arch', 'invalid_meta', false)
  const osRelease = text('osRelease', 'invalid_meta', false)
  const installId = text('installId', 'invalid_meta', false)
  if (
    !/^[0-9A-Za-z.+-]{1,32}$/.test(appVersion) ||
    (platform !== undefined && !(PLATFORMS as readonly string[]).includes(platform)) ||
    (arch !== undefined && !(ARCHES as readonly string[]).includes(arch)) ||
    (osRelease !== undefined && !/^[0-9A-Za-z._-]{1,64}$/.test(osRelease)) ||
    (installId !== undefined && !UUID_V4.test(installId))
  ) {
    throw new Rejection('invalid_meta')
  }

  const files = form.getAll('image')
  if (files.length > MAX_IMAGES) throw new Rejection('too_many_images')
  const images: SanitizedImage[] = []
  for (const file of files) {
    if (typeof file === 'string') throw new Rejection('bad_image')
    if (file.size > MAX_IMAGE_BYTES) throw new Rejection('image_too_large')
    // 送ってきた Content-Type・ファイル名は見ない。中身で判定し、メタデータを取り除く
    const image = sanitizeImage(new Uint8Array(await file.arrayBuffer()))
    if (!image) throw new Rejection('bad_image')
    images.push(image)
  }
  return { kind: kind as Submission['kind'], title, body, appVersion, platform, arch, osRelease, installId, images }
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ── 画像を返す ─────────────────────────────────────────── */

async function serveMedia(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method_not_allowed', { allow: 'GET, HEAD' })
  const m = /^\/v1\/media\/([0-9a-f]{32})\.(png|jpg)$/.exec(pathname)
  if (!m) return fail('not_found')
  const object = await env.MEDIA.get(`v1/${m[1]}.${m[2]}`)
  if (!object?.body) return fail('not_found')
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      // 保存した値ではなく、名前（中身を確かめて付けたもの）から決める
      'content-type': m[2] === 'png' ? 'image/png' : 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline'
    }
  })
}
