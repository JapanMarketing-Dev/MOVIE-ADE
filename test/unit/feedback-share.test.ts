import { describe, expect, it } from 'vitest'
import type { Env, RoomStorage } from '../../workers/feedback-share/src/env'
import { handle, type Deps } from '../../workers/feedback-share/src/index'
import { COMMENT_PER_IP } from '../../workers/feedback-share/src/limits'
import { SHARE_HTML, SHARE_JS } from '../../workers/feedback-share/src/page'
import { ShareRoom, sameHash } from '../../workers/feedback-share/src/room'
import { FeedbackLimiter } from '../../workers/feedback-relay/src/limiter'
import type { LimiterStorage } from '../../workers/feedback-relay/src/env'
import {
  SHARE_LIMITS, commentNoteText, parseShareLink, sanitizeCommentInput, sanitizeShape, shapeToBox, shareUrl
} from '../../src/shared/feedbackShare'

/**
 * ログイン無しの共有リンク（workers/feedback-share）。偽の env（R2・Durable Object）で動かし、本物の Cloudflare には送らない。
 */

const BASE = 'https://share.ferretade.dev'
const IP = '203.0.113.9'

class MemoryStorage implements RoomStorage, LimiterStorage {
  data = new Map<string, unknown>()
  alarm: number | null = null
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)) }
  async delete(key: string) { return this.data.delete(key) }
  async list<T>(options: { prefix: string }) {
    return new Map([...this.data].filter(([k]) => k.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b)) as Array<[string, T]>)
  }
  async deleteAll() { this.data.clear(); this.alarm = null }
  async setAlarm(time: number) { this.alarm = time }
}

function fakeEnv() {
  const media = new Map<string, Uint8Array>()
  const rooms = new Map<string, { storage: MemoryStorage; obj: ShareRoom }>()
  const limiters = new Map<string, { storage: MemoryStorage; obj: FeedbackLimiter }>()
  const MEDIA: Env['MEDIA'] = {
    async put(key, value) { media.set(key, new Uint8Array(value as Uint8Array)) },
    async get(key) { const v = media.get(key); return v ? { body: new Blob([v as BlobPart]).stream() } : null },
    async delete(key) { media.delete(key) }
  }
  const env: Env = {
    RATE_LIMIT_SALT: 'test-salt',
    PUBLIC_BASE: BASE,
    MEDIA,
    ROOMS: {
      idFromName: (name) => name,
      get(id) {
        const name = id as string
        if (!rooms.has(name)) { const storage = new MemoryStorage(); rooms.set(name, { storage, obj: new ShareRoom({ storage }, { MEDIA }) }) }
        const entry = rooms.get(name)!
        return { fetch: (r: Request) => entry.obj.fetch(r) }
      }
    },
    LIMITER: {
      idFromName: (name) => name,
      get(id) {
        const name = id as string
        if (!limiters.has(name)) { const storage = new MemoryStorage(); limiters.set(name, { storage, obj: new FeedbackLimiter({ storage }) }) }
        const entry = limiters.get(name)!
        return { fetch: (r: Request) => entry.obj.fetch(r) }
      }
    }
  }
  return { env, media, rooms, limiters }
}

let counter = 0
function deps(now = Date.parse('2026-10-07T00:00:00Z')): Deps & { set(t: number): void } {
  let t = now
  return {
    now: () => t,
    set(next: number) { t = next },
    random: (bytes) => (++counter).toString(16).padStart(bytes * 2, 'a').slice(-bytes * 2)
  }
}

/* ── 画像の材料（feedback-relay のテストと同じ作り） ── */
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const chunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0]
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), ...chunk('tEXt', ascii('Author\u0000taro')), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])])

const req = (path: string, init: RequestInit & { ip?: string } = {}) => {
  const headers = new Headers(init.headers)
  headers.set('cf-connecting-ip', init.ip ?? IP)
  return new Request(`${BASE}${path}`, { ...init, headers })
}

async function create(env: Env, d: Deps, body: Record<string, unknown> = { title: 'Acme shop', showOthers: false }) {
  const res = await handle(req('/v1/shares', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, d)
  return { res, body: await res.json() as { ok: boolean; id: string; ownerToken: string; url: string; expiresAt: string; code?: string } }
}

async function addPage(env: Env, d: Deps, id: string, token: string, image: Uint8Array = png(), meta: Record<string, unknown> = { url: 'https://acme.example/', title: 'Home', viewport: 'desktop', width: 1280, height: 800 }) {
  const form = new FormData()
  form.set('meta', JSON.stringify(meta))
  form.set('image', new Blob([image as BlobPart], { type: 'image/png' }), 'shot.png')
  const res = await handle(req(`/v1/shares/${id}/pages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form }), env, d)
  return { res, body: await res.json() as { ok: boolean; page: { id: string; ext: string }; code?: string } }
}

const comment = (env: Env, d: Deps, id: string, body: Record<string, unknown>, ip?: string, origin: string | null = BASE) =>
  handle(req(`/v1/public/${id}/comments`, { method: 'POST', ip, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }), env, d)

const snapshot = async (env: Env, d: Deps, id: string, token: string) =>
  (await (await handle(req(`/v1/shares/${id}`, { headers: { authorization: `Bearer ${token}` } }), env, d)).json()) as { ok: boolean; code?: string; share: { comments: Array<{ id: string; status: string; text: string; name?: string }>; pages: unknown[] } }

describe('共有を作る（持ち主）', () => {
  it('推測できない ID とトークンを返し、部屋にはトークンのハッシュだけを置く', async () => {
    const { env, rooms } = fakeEnv()
    const d = deps()
    const { res, body } = await create(env, d)
    expect(res.status).toBe(201)
    expect(body.id).toMatch(/^[0-9a-f]{32}$/)
    expect(body.ownerToken).toMatch(/^[0-9a-f]{64}$/)
    expect(body.url).toBe(shareUrl(body.id, BASE))
    expect(Date.parse(body.expiresAt) - d.now()).toBe(SHARE_LIMITS.defaultDays * 86_400_000)
    const stored = JSON.stringify([...rooms.get(body.id)!.storage.data.values()])
    expect(stored).not.toContain(body.ownerToken)
    expect(rooms.get(body.id)!.storage.alarm).toBe(Date.parse(body.expiresAt))
  })

  it('ブラウザ（Origin の付いた要求）からは作れない', async () => {
    const { env } = fakeEnv()
    const res = await handle(req('/v1/shares', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' }), env, deps())
    expect(res.status).toBe(403)
  })

  it('作る数に上限がある（IP ごと）', async () => {
    const { env } = fakeEnv()
    const d = deps()
    for (let i = 0; i < 10; i++) expect((await create(env, d)).res.status).toBe(201)
    const over = await create(env, d)
    expect(over.res.status).toBe(429)
    expect(over.res.headers.get('retry-after')).toBeTruthy()
  })
})

describe('ページを足す', () => {
  it('静止画のメタデータを取り除いて置き、違うトークン・壊れた画像・数の上限は断る', async () => {
    const { env, media } = fakeEnv()
    const d = deps()
    const { body: share } = await create(env, d)
    const ok = await addPage(env, d, share.id, share.ownerToken)
    expect(ok.res.status).toBe(201)
    const key = `s/${share.id}/${ok.body.page.id}.png`
    expect(new TextDecoder().decode(media.get(key)!)).not.toContain('taro')

    expect((await addPage(env, d, share.id, 'f'.repeat(64))).res.status).toBe(401)
    expect((await addPage(env, d, share.id, share.ownerToken, new TextEncoder().encode('GIF89a not an image'))).res.status).toBe(415)
    expect((await addPage(env, d, share.id, share.ownerToken, png(), { url: 'javascript:alert(1)', title: 'x', viewport: 'desktop', width: 10, height: 10 })).res.status).toBe(400)
    for (let i = 1; i < SHARE_LIMITS.pages; i++) expect((await addPage(env, d, share.id, share.ownerToken)).res.status).toBe(201)
    const before = media.size
    expect((await addPage(env, d, share.id, share.ownerToken)).res.status).toBe(409)
    // 断ったページの静止画は残さない
    expect(media.size).toBe(before)
  })
})

describe('相手（ログイン無し）の画面と送信', () => {
  async function ready(showOthers = false) {
    const f = fakeEnv()
    const d = deps()
    const { body: share } = await create(f.env, d, { title: 'Acme shop', showOthers })
    const { body: page } = await addPage(f.env, d, share.id, share.ownerToken)
    return { ...f, d, share, pageId: page.page.id }
  }

  it('画面は厳しい CSP・noindex・Referrer なしで配り、文字は textContent でだけ出す', async () => {
    const { env, d, share } = await ready()
    const res = await handle(req(`/s/${share.id}`), env, d)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/)
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await res.text()).toBe(SHARE_HTML)
    expect(SHARE_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/)
    // 中に書いたスクリプト（src の無い script）と、外の URL を読まない
    const inlineScripts = [...SHARE_HTML.toLowerCase().split('<script').slice(1)].filter((rest) => !rest.slice(0, rest.indexOf('>')).includes('src='))
    expect(inlineScripts).toEqual([])
    expect(SHARE_HTML).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    expect((await handle(req('/s/not-an-id'), env, d)).status).toBe(404)
  })

  it('中身にはトークンも断った指摘も載らず、ほかの人の指摘は許したときだけ見える', async () => {
    for (const showOthers of [false, true]) {
      const { env, d, share, pageId } = await ready(showOthers)
      expect((await comment(env, d, share.id, { pageId, text: 'Button is cut off', name: 'Hanako', shape: { kind: 'pin', x: 0.5, y: 0.25 } })).status).toBe(201)
      const second = await (await comment(env, d, share.id, { pageId, text: 'spam spam' })).json() as { id: string }
      await handle(req(`/v1/shares/${share.id}/comments/${second.id}`, { method: 'POST', headers: { authorization: `Bearer ${share.ownerToken}`, 'content-type': 'application/json' }, body: '{"status":"rejected"}' }), env, d)
      const view = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: { comments: Array<{ text: string }>; pages: unknown[] } }
      const text = JSON.stringify(view)
      expect(text).not.toContain(share.ownerToken)
      expect(text).not.toContain('tokenHash')
      expect(view.share.pages).toHaveLength(1)
      expect(view.share.comments.map((c) => c.text)).toEqual(showOthers ? ['Button is cut off'] : [])
    }
  })

  it('送信は Worker の画面の Origin からだけ受け、値を確かめる', async () => {
    const { env, d, share, pageId } = await ready()
    expect((await comment(env, d, share.id, { pageId, text: 'hi' }, undefined, null)).status).toBe(403)
    expect((await comment(env, d, share.id, { pageId, text: 'hi' }, undefined, 'https://evil.example')).status).toBe(403)
    expect((await comment(env, d, share.id, { pageId, text: '   ' })).status).toBe(400)
    expect((await comment(env, d, share.id, { pageId, text: 'x'.repeat(SHARE_LIMITS.textChars + 1) })).status).toBe(400)
    expect((await comment(env, d, share.id, { pageId, text: 'ok', shape: { kind: 'pin', x: 2, y: 0 } })).status).toBe(400)
    expect((await comment(env, d, share.id, { pageId, text: 'ok', extra: 1 })).status).toBe(400)
    expect((await comment(env, d, share.id, { pageId: '0'.repeat(16), text: 'ok' })).status).toBe(404)
    expect((await comment(env, d, share.id, { pageId, text: 'ok', live: { url: 'javascript:alert(1)' } })).status).toBe(400)
    const good = await comment(env, d, share.id, { pageId, text: 'Line1\nLine2\u0007', name: '  Taro ', live: { url: 'https://acme.example/cart' }, shape: { kind: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.2 } })
    expect(good.status).toBe(201)
    const snap = await snapshot(env, d, share.id, share.ownerToken)
    expect(snap.share.comments).toEqual([expect.objectContaining({ text: 'Line1\nLine2', name: 'Taro', status: 'new' })])
  })

  it('honeypot に何か入った送信は保存せずに成功のふりをする', async () => {
    const { env, d, share, pageId } = await ready()
    const res = await comment(env, d, share.id, { pageId, text: 'buy cheap', website: 'http://spam.example' })
    expect(res.status).toBe(201)
    expect((await snapshot(env, d, share.id, share.ownerToken)).share.comments).toEqual([])
  })

  it('IP ごとの上限を超えたら断り、断った送信で共有の枠を減らさない', async () => {
    const { env, d, share, pageId, limiters } = await ready()
    const max = COMMENT_PER_IP[0]!.max
    for (let i = 0; i < max; i++) expect((await comment(env, d, share.id, { pageId, text: `n${i}` })).status).toBe(201)
    expect((await comment(env, d, share.id, { pageId, text: 'over' })).status).toBe(429)
    const shareTimes = [...limiters.entries()].filter(([k]) => k.startsWith('share-comment-share:')).map(([, v]) => (v.storage.data.get('times') as number[]).length)
    expect(shareTimes).toEqual([max])
    // 別の IP からは送れる
    expect((await comment(env, d, share.id, { pageId, text: 'other ip' }, '198.51.100.2')).status).toBe(201)
  })

  it('静止画は共有の中のページだけ返す', async () => {
    const { env, d, share, pageId } = await ready()
    const res = await handle(req(`/v1/public/${share.id}/pages/${pageId}.png`), env, d)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect((await handle(req(`/v1/public/${share.id}/pages/${pageId}.jpg`), env, d)).status).toBe(404)
    expect((await handle(req(`/v1/public/${share.id}/pages/../../x.png`), env, d)).status).toBe(404)
  })
})

describe('持ち主の操作と期限', () => {
  it('取り込んだ・断ったの状態を変え、指摘・共有を消す。共有を消すと静止画も消える', async () => {
    const { env, media } = fakeEnv()
    const d = deps()
    const { body: share } = await create(env, d)
    const { body: page } = await addPage(env, d, share.id, share.ownerToken)
    const sent = await (await comment(env, d, share.id, { pageId: page.page.id, text: 'Fix the header' })).json() as { id: string }
    const auth = { authorization: `Bearer ${share.ownerToken}` }
    expect((await handle(req(`/v1/shares/${share.id}/comments/${sent.id}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"status":"imported"}' }), env, d)).status).toBe(200)
    expect((await snapshot(env, d, share.id, share.ownerToken)).share.comments[0]!.status).toBe('imported')
    expect((await handle(req(`/v1/shares/${share.id}/comments/${sent.id}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"status":"deleted"}' }), env, d)).status).toBe(400)
    expect((await handle(req(`/v1/shares/${share.id}/comments/${sent.id}`, { method: 'DELETE', headers: auth }), env, d)).status).toBe(200)
    expect((await snapshot(env, d, share.id, share.ownerToken)).share.comments).toEqual([])
    // トークンが無い・違う
    expect((await handle(req(`/v1/shares/${share.id}`), env, d)).status).toBe(401)
    expect((await handle(req(`/v1/shares/${share.id}`, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } }), env, d)).status).toBe(401)
    expect(media.size).toBe(1)
    expect((await handle(req(`/v1/shares/${share.id}`, { method: 'DELETE', headers: auth }), env, d)).status).toBe(200)
    expect(media.size).toBe(0)
    expect((await handle(req(`/v1/public/${share.id}`), env, d)).status).toBe(404)
  })

  it('期限を過ぎたら相手には 410、alarm で静止画と記録を消す', async () => {
    const { env, media, rooms } = fakeEnv()
    const d = deps()
    const { body: share } = await create(env, d, { title: 't', days: 1 })
    const { body: page } = await addPage(env, d, share.id, share.ownerToken)
    d.set(Date.parse(share.expiresAt) + 1)
    expect((await handle(req(`/v1/public/${share.id}`), env, d)).status).toBe(410)
    expect((await comment(env, d, share.id, { pageId: page.page.id, text: 'late' })).status).toBe(410)
    const realNow = Date.now
    Date.now = () => Date.parse(share.expiresAt) + 1
    try {
      await rooms.get(share.id)!.obj.alarm()
    } finally {
      Date.now = realNow
    }
    expect(media.size).toBe(0)
    expect(rooms.get(share.id)!.storage.data.size).toBe(0)
  })

  it('トークンの比較は長さが違えば false', () => {
    expect(sameHash('ab', 'ab')).toBe(true)
    expect(sameHash('ab', 'ac')).toBe(false)
    expect(sameHash('ab', 'abc')).toBe(false)
  })
})

describe('共有の形（src/shared/feedbackShare.ts）', () => {
  it('形は 0..1 の座標だけを受け、丸める', () => {
    expect(sanitizeShape({ kind: 'pin', x: 0.123456, y: 1 })).toEqual({ kind: 'pin', x: 0.1235, y: 1 })
    expect(sanitizeShape({ kind: 'rect', x: 0.5, y: 0.5, w: 0.6, h: 0.1 })).toBeNull()
    expect(sanitizeShape({ kind: 'rect', x: 0.1, y: 0.1, w: 0, h: 0.1 })).toBeNull()
    expect(sanitizeShape({ kind: 'pen', points: [[0, 0]] })).toBeNull()
    expect(sanitizeShape({ kind: 'pen', points: Array.from({ length: SHARE_LIMITS.penPoints + 1 }, () => [0.1, 0.1]) })).toBeNull()
    expect(sanitizeShape({ kind: 'pen', points: [[0, 0], [0.5, Number.NaN]] })).toBeNull()
    expect(sanitizeShape({ kind: 'circle', x: 0, y: 0 })).toBeNull()
  })

  it('形を静止画の枠にする（はみ出さない）', () => {
    expect(shapeToBox({ kind: 'rect', x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, 1000, 800)).toEqual([100, 160, 500, 200])
    expect(shapeToBox({ kind: 'pin', x: 0, y: 0 }, 1000, 800)).toEqual([0, 0, 32, 32])
    const [x, y, w, h] = shapeToBox({ kind: 'pin', x: 1, y: 1 }, 1000, 800)
    expect(x + w).toBeLessThanOrEqual(1000)
    expect(y + h).toBeLessThanOrEqual(800)
    expect(shapeToBox({ kind: 'pen', points: [[0.1, 0.1], [0.2, 0.3]] }, 1000, 1000)).toEqual([92, 92, 116, 216])
    expect(shapeToBox(undefined, 640, 480)).toEqual([0, 0, 640, 480])
  })

  it('リンクから ID を取り出す', () => {
    const id = 'a'.repeat(32)
    expect(parseShareLink(`${BASE}/s/${id}`)).toBe(id)
    expect(parseShareLink(`${BASE}/s/${id}?x=1`)).toBe(id)
    expect(parseShareLink(id)).toBe(id)
    expect(parseShareLink(`https://evil.example/s/${id}`)).toBeNull()
    expect(parseShareLink('nope')).toBeNull()
  })

  it('送信の値は許可リストで確かめる', () => {
    const pageId = '1'.repeat(16)
    expect(sanitizeCommentInput({ pageId, text: 'a', name: '' })).toEqual({ pageId, text: 'a' })
    expect(sanitizeCommentInput({ pageId, text: 'a', name: 'n'.repeat(51) })).toEqual({ error: 'too_long' })
    expect(sanitizeCommentInput({ pageId, text: 'a', viewWidth: 1.5 })).toEqual({ pageId, text: 'a' })
    expect(sanitizeCommentInput([])).toEqual({ error: 'invalid' })
  })

  it('取り込む文は名前と、別の URL を見ていたときの URL を添える', () => {
    expect(commentNoteText({ name: 'Hanako', text: 'Fix it' }, { url: 'https://a.example/' })).toBe('Hanako: Fix it')
    expect(commentNoteText({ text: 'Fix it', live: { url: 'https://a.example/cart' } }, { url: 'https://a.example/' })).toBe('Fix it\n(https://a.example/cart)')
    expect(commentNoteText({ text: 'Fix it', live: { url: 'https://a.example/' } }, { url: 'https://a.example/' })).toBe('Fix it')
  })
})
