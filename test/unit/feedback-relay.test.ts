import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, LimiterStorage } from '../../workers/feedback-relay/src/env'
import { ISSUE_HEADING } from '../../workers/feedback-relay/src/github'
import { sanitizeImage } from '../../workers/feedback-relay/src/images'
import { handle } from '../../workers/feedback-relay/src/index'
import { decide, FeedbackLimiter, KEEP_MS, sourceIdentity } from '../../workers/feedback-relay/src/limiter'
import { PREPARSE_LIMITS } from '../../workers/feedback-relay/src/limits'
import { literalBlock, neutralizeMentions, redact } from '../../workers/feedback-relay/src/redact'

/**
 * 匿名フィードバックの中継（workers/feedback-relay）。偽の env（R2・Durable Object・fetch）で動かし、
 * 本物の GitHub・Cloudflare には送らない。
 */

const TOKEN = ['fake', 'github', 'token', 'for', 'tests'].join('-')
const SALT = 'test-salt'
const IP = '203.0.113.7'
const INSTALL = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const INSTALL2 = '9e8d7c6b-5a49-4382-b716-05f4e3d2c1b0'
const BASE = 'https://feedback.ferretade.dev'
// 本物に見えるトークンをリポジトリに置かないよう、実行時に組み立てる
const GH_TOKEN_LIKE = `gh${'p'}_${'A1b2C3d4E5'.repeat(4)}`

/* ── 偽の env ───────────────────────────────────── */

class MemoryStorage implements LimiterStorage {
  data = new Map<string, unknown>()
  alarm: number | null = null
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, value)
  }
  async deleteAll() {
    this.data.clear()
    this.alarm = null
  }
  async setAlarm(time: number) {
    this.alarm = time
  }
}

function fakeEnv() {
  const media = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const limiters = new Map<string, { storage: MemoryStorage; obj: FeedbackLimiter }>()
  const queues = new Map<string, Promise<unknown>>()
  const env: Env = {
    GITHUB_TOKEN: TOKEN,
    RATE_LIMIT_SALT: SALT,
    GITHUB_REPO: 'JapanMarketing-Dev/ferret',
    PUBLIC_BASE: BASE,
    MEDIA: {
      async put(key, value, options) {
        media.set(key, { bytes: new Uint8Array(value as Uint8Array), contentType: options?.httpMetadata?.contentType })
      },
      async get(key) {
        const v = media.get(key)
        return v ? { body: new Blob([v.bytes as BlobPart]).stream() } : null
      },
      async delete(key) {
        media.delete(key)
      }
    },
    LIMITER: {
      idFromName: (name) => name,
      get(id) {
        const name = id as string
        if (!limiters.has(name)) {
          const storage = new MemoryStorage()
          limiters.set(name, { storage, obj: new FeedbackLimiter({ storage }) })
        }
        // Durable Object は1つの鍵の要求を1つずつ処理する（input gate）。偽物も鍵ごとに1つずつ流す
        const entry = limiters.get(name)!
        return {
          fetch: (r: Request) => {
            const run = (queues.get(name) ?? Promise.resolve()).then(() => entry.obj.fetch(r))
            queues.set(name, run.catch(() => undefined))
            return run
          }
        }
      }
    }
  }
  return { env, media, limiters }
}

type GhCall = { url: string; init: RequestInit }

function fakeGithub(status = 201) {
  const calls: GhCall[] = []
  let n = 100
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    n += 1
    return status === 201
      ? Response.json({ number: n, html_url: `https://github.com/JapanMarketing-Dev/ferret/issues/${n}` }, { status: 201 })
      : Response.json({ message: 'nope' }, { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/* ── 画像の材料 ─────────────────────────────────── */

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const chunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0]
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function png({ text = 'Author\u0000taro GPS 35.6', trailing = [] as number[] } = {}) {
  return new Uint8Array([
    ...PNG_SIG,
    ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    ...chunk('tEXt', ascii(text)),
    ...chunk('IDAT', [1, 2, 3, 4]),
    ...chunk('IEND', []),
    ...trailing
  ])
}

function jpeg() {
  const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload]
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, ascii('JFIF\u0000\u0001\u0001')),
    ...seg(0xe1, ascii('Exif\u0000\u0000GPSLatitude 35.6')),
    ...seg(0xfe, ascii('comment by taro')),
    ...seg(0xdb, [0, 1, 2, 3]),
    ...seg(0xda, [0, 1, 2]),
    9, 8, 7, 6,
    0xff, 0xd9
  ])
}

const has = (bytes: Uint8Array, s: string) => Buffer.from(bytes).includes(Buffer.from(s))

/* ── 送信の材料 ─────────────────────────────────── */

type Fields = Partial<Record<string, string | string[]>>
type ImagePart = { bytes: Uint8Array; type?: string; name?: string }

function form(fields: Fields = {}, images: ImagePart[] = []) {
  const f = new FormData()
  const all: Fields = { kind: 'bug', title: 'Recording stops', body: 'It stops after 10 seconds.', appVersion: '0.2.0', platform: 'darwin', arch: 'arm64', osRelease: '25.6.0', installId: INSTALL, ...fields }
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one)
  }
  for (const img of images) f.append('image', new Blob([img.bytes as BlobPart], { type: img.type ?? 'image/png' }), img.name ?? 'shot.png')
  return f
}

function post(body: FormData | BodyInit, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/v1/issues`, { method: 'POST', body, headers: { 'cf-connecting-ip': IP, ...headers } })
}

async function send(env: Env, gh: ReturnType<typeof fakeGithub>, req: Request, now = 1_800_000_000_000) {
  const res = await handle(req, env, { fetch: gh.fetchImpl, now: () => now })
  return { res, json: (await res.clone().json()) as Record<string, unknown> }
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  // ログに秘密・IP・本文が出ていない
  for (const call of errorSpy.mock.calls) {
    const text = call.map(String).join(' ')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(IP)
  }
  errorSpy.mockRestore()
})

/* ── テスト ─────────────────────────────────────── */

describe('feedback-relay: Issue を作る', () => {
  it('匿名の見出し・ラベル（bug + from-app）・メタデータを付けて、GitHub の API を1回呼ぶ', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const { res, json } = await send(env, gh, post(form()))
    expect(res.status).toBe(201)
    expect(json).toEqual({ ok: true, issue: 101, url: 'https://github.com/JapanMarketing-Dev/ferret/issues/101' })
    expect(gh.calls).toHaveLength(1)
    const call = gh.calls[0]
    expect(call.url).toBe('https://api.github.com/repos/JapanMarketing-Dev/ferret/issues')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['x-github-api-version']).toBe('2022-11-28')
    const sent = JSON.parse(String(call.init.body)) as { title: string; body: string; labels: string[] }
    expect(Object.keys(sent).sort()).toEqual(['body', 'labels', 'title'])
    expect(sent.title).toBe('Recording stops')
    expect(sent.labels).toEqual(['bug', 'from-app'])
    expect(sent.body.startsWith(`${ISSUE_HEADING}\n`)).toBe(true)
    expect(sent.body).toContain('**Kind:** bug · **App:** 0.2.0 · **OS:** darwin 25.6.0 (arm64)')
    expect(sent.body).toContain('It stops after 10 seconds.')
    // インストール ID と IP は Issue に書かない
    expect(sent.body).not.toContain(INSTALL)
    expect(sent.body).not.toContain(IP)
    // 応答にトークンを出さない
    expect(JSON.stringify(json)).not.toContain(TOKEN)
  })

  it('enhancement のラベルも付けられる', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    await send(env, gh, post(form({ kind: 'enhancement' })))
    expect(JSON.parse(String(gh.calls[0].init.body)).labels).toEqual(['enhancement', 'from-app'])
  })

  it('画像は推測できない名前で R2 に置き、メタデータを取り除き、Issue に中継の URL で貼る', async () => {
    const { env, media } = fakeEnv()
    const gh = fakeGithub()
    const { res } = await send(env, gh, post(form({}, [{ bytes: png() }, { bytes: jpeg(), type: 'image/jpeg', name: 'x.jpg' }])))
    expect(res.status).toBe(201)
    const keys = [...media.keys()]
    expect(keys).toHaveLength(2)
    for (const k of keys) expect(k).toMatch(/^v1\/[0-9a-f]{32}\.(png|jpg)$/)
    const [pngObj, jpgObj] = keys.map((k) => media.get(k)!)
    expect(pngObj.contentType).toBe('image/png')
    expect(has(pngObj.bytes, 'taro')).toBe(false)
    expect(has(jpgObj.bytes, 'GPSLatitude')).toBe(false)
    expect(has(jpgObj.bytes, 'comment by taro')).toBe(false)
    const body = JSON.parse(String(gh.calls[0].init.body)).body as string
    for (const k of keys) expect(body).toContain(`![screenshot`)
    for (const k of keys) expect(body).toContain(`${BASE}/v1/media/${k.slice(3)}`)
  })

  it('GitHub が作らなかった（4xx）ら 502 upstream_failed。置いた画像は消し、同じ内容をあとで送り直せる', async () => {
    const { env, media } = fakeEnv()
    const bad = fakeGithub(422)
    const first = await send(env, bad, post(form({}, [{ bytes: png() }])))
    expect(first.res.status).toBe(502)
    expect(first.json).toEqual({ ok: false, code: 'upstream_failed' })
    expect(media.size).toBe(0)
    const again = await send(env, fakeGithub(), post(form({}, [{ bytes: png() }])))
    expect(again.res.status).toBe(201)
  })
})

describe('feedback-relay: 送り方の制限', () => {
  it('Origin の付いた送信（ブラウザ）は 403 origin_not_allowed。CORS のヘッダーも出さない', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const { res, json } = await send(env, gh, post(form(), { origin: 'https://evil.example' }))
    expect(res.status).toBe(403)
    expect(json).toEqual({ ok: false, code: 'origin_not_allowed' })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(gh.calls).toHaveLength(0)
  })

  it('OPTIONS・GET は 405、知らないパスは 404', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    expect((await send(env, gh, new Request(`${BASE}/v1/issues`, { method: 'GET' }))).json.code).toBe('method_not_allowed')
    expect((await send(env, gh, new Request(`${BASE}/v1/issues`, { method: 'OPTIONS' }))).res.status).toBe(405)
    expect((await send(env, gh, new Request(`${BASE}/v1/feedback`, { method: 'POST' }))).json.code).toBe('not_found')
  })

  it('multipart でなければ 415 unsupported_media_type', async () => {
    const { env } = fakeEnv()
    const r = await send(env, fakeGithub(), post(JSON.stringify({ kind: 'bug' }), { 'content-type': 'application/json' }))
    expect(r.res.status).toBe(415)
    expect(r.json).toEqual({ ok: false, code: 'unsupported_media_type' })
  })

  it('全体が 8MB を超えると 413 too_large（Content-Length でも、偽ったり無かったりしても）', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const declared = await send(env, gh, post('x', { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(9 * 1024 * 1024) }))
    expect(declared.json.code).toBe('too_large')
    const big = new Uint8Array(8 * 1024 * 1024 + 1)
    const streamed = await send(
      env,
      gh,
      new Request(`${BASE}/v1/issues`, { method: 'POST', body: new Blob([big]).stream(), headers: { 'content-type': 'multipart/form-data; boundary=x' }, duplex: 'half' } as RequestInit)
    )
    expect(streamed.res.status).toBe(413)
    expect(gh.calls).toHaveLength(0)
  })
})

describe('feedback-relay: フィールドの許可リストと上限', () => {
  const cases: Array<[string, Fields, string]> = [
    ['知らないフィールド', { email: 'a@example.com' }, 'unknown_field'],
    ['githubLogin（匿名なので受けない）', { githubLogin: 'someone' }, 'unknown_field'],
    ['kind が知らない値', { kind: 'question' }, 'invalid_kind'],
    ['kind が2つ', { kind: ['bug', 'enhancement'] }, 'invalid_kind'],
    ['題名が 201 字', { title: 'あ'.repeat(201) }, 'invalid_title'],
    ['題名が空', { title: '   ' }, 'invalid_title'],
    ['題名に改行', { title: 'a\nb' }, 'invalid_title'],
    ['題名に向きを変える制御文字', { title: 'a\u202eb' }, 'invalid_title'],
    ['本文が 20KB を超える', { body: 'a'.repeat(20 * 1024 + 1) }, 'invalid_body'],
    ['本文が空', { body: '\n\n' }, 'invalid_body'],
    ['本文に NUL', { body: 'a\u0000b' }, 'invalid_body'],
    ['platform が知らない値', { platform: 'android' }, 'invalid_meta'],
    ['arch が知らない値', { arch: 'ia32' }, 'invalid_meta'],
    ['appVersion に記号', { appVersion: '0.2.0; rm -rf' }, 'invalid_meta'],
    ['installId が UUID v4 でない', { installId: 'not-a-uuid' }, 'invalid_meta'],
    ['appVersion が無い', { appVersion: undefined }, 'invalid_meta'],
    ['installId が2つ', { installId: [INSTALL, INSTALL2] }, 'invalid_meta'],
    ['osRelease が長すぎる', { osRelease: 'x'.repeat(65) }, 'invalid_meta']
  ]
  it.each(cases)('%s → 400 %s 相当（code だけを返し、GitHub は呼ばない）', async (_label, fields, code) => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const { res, json } = await send(env, gh, post(form(fields)))
    expect(json).toEqual({ ok: false, code })
    expect(res.status).toBe(400)
    expect(gh.calls).toHaveLength(0)
  })

  it('環境情報（platform・arch・osRelease）とインストール ID は任意。外したら Issue の OS は not shared', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const { res } = await send(env, gh, post(form({ platform: undefined, arch: undefined, osRelease: undefined, installId: undefined })))
    expect(res.status).toBe(201)
    expect(JSON.parse(String(gh.calls[0].init.body)).body).toContain('**Kind:** bug · **App:** 0.2.0 · **OS:** not shared')
  })

  it('題名と本文の日本語（UTF-8 の multipart）はそのまま Issue になる', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const title = '録画が10秒で止まる 🐞'
    const body = '手順:\n1. 録画を始める\n2. 10秒待つ\n「止まった」と表示される'
    await send(env, gh, post(form({ title, body })))
    const sent = JSON.parse(String(gh.calls[0].init.body)) as { title: string; body: string }
    expect(sent.title).toBe(title)
    expect(sent.body).toContain(body)
  })

  it('題名 200 字・本文 20KB ちょうどは通る', async () => {
    const { env } = fakeEnv()
    const { res } = await send(env, fakeGithub(), post(form({ title: 'あ'.repeat(200), body: 'a'.repeat(20 * 1024) })))
    expect(res.status).toBe(201)
  })
})

describe('feedback-relay: 画像の検査', () => {
  it('4枚は too_many_images、2MB を超える1枚は image_too_large', async () => {
    const { env } = fakeEnv()
    const four = await send(env, fakeGithub(), post(form({}, [1, 2, 3, 4].map(() => ({ bytes: png() })))))
    expect(four.json).toEqual({ ok: false, code: 'too_many_images' })
    const huge = new Uint8Array(2 * 1024 * 1024 + 1)
    huge.set(png())
    const big = await send(env, fakeGithub(), post(form({}, [{ bytes: huge }])))
    expect(big.res.status).toBe(413)
    expect(big.json.code).toBe('image_too_large')
  })

  it.each([
    ['PNG と名乗る GIF', new Uint8Array([...ascii('GIF89a'), 1, 0, 1, 0])],
    ['PNG と名乗る HTML', new Uint8Array(ascii('<svg onload=alert(1)>'))],
    ['途中で切れた PNG', png().subarray(0, 30)],
    ['IHDR で始まらない PNG', new Uint8Array([...PNG_SIG, ...chunk('IDAT', [1]), ...chunk('IEND', [])])],
    ['EOI の無い JPEG', jpeg().subarray(0, jpeg().length - 2)],
    ['空のファイル', new Uint8Array()]
  ])('%s は 415 bad_image（送られた Content-Type は信用しない）', async (_label, bytes) => {
    const { env, media } = fakeEnv()
    const { res, json } = await send(env, fakeGithub(), post(form({}, [{ bytes, type: 'image/png' }])))
    expect(res.status).toBe(415)
    expect(json).toEqual({ ok: false, code: 'bad_image' })
    expect(media.size).toBe(0)
  })

  it('PNG の IEND のあとに付けたもの（別のファイルを隠すなど）は捨てる', () => {
    const out = sanitizeImage(png({ trailing: ascii('PK\u0003\u0004 hidden zip') }))!
    expect(out.ext).toBe('png')
    expect(has(out.bytes, 'hidden zip')).toBe(false)
    expect(has(out.bytes, 'IEND')).toBe(true)
  })
})

describe('feedback-relay: 伏せ字', () => {
  it('鍵・トークン・メール・ホームのパスを伏せ字にし、@メンションと #参照を崩す', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const secrets = [
      GH_TOKEN_LIKE,
      `github_pat_${'Z9'.repeat(30)}`,
      `sk-ant-api03-${'q'.repeat(30)}`,
      `sk-proj-${'r'.repeat(30)}`,
      `AKIA${'B'.repeat(16)}`,
      `AIza${'c'.repeat(35)}`,
      `xoxb-${'1234567890'.repeat(2)}`,
      `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`
    ]
    const body = [
      ...secrets,
      'api_key = "supersecretvalue123"',
      'Authorization: Bearer abcdefghijklmnopqrstu',
      'https://user:hunter2pass@example.com/path',
      'mail me: taro.yamada@example.co.jp',
      'log at /Users/taro/Library/Logs/ferret.log',
      'or /home/taro/.config/ferret',
      'or C:\\Users\\TaroY\\AppData\\Roaming\\ferret',
      'cc @octocat and see #12'
    ].join('\n')
    await send(env, gh, post(form({ body, title: `crash for @octocat at /Users/taroyamada` })))
    const sent = JSON.parse(String(gh.calls[0].init.body)) as { title: string; body: string }
    for (const s of secrets) expect(sent.body).not.toContain(s)
    for (const leaked of ['supersecretvalue123', 'abcdefghijklmnopqrstu', 'hunter2pass', 'taro.yamada@example.co.jp', 'taroyamada', '/home/taro/', 'TaroY']) {
      expect(sent.body).not.toContain(leaked)
    }
    expect(sent.body).toContain('/Users/<user>/Library/Logs/ferret.log')
    expect(sent.body).toContain('/home/<user>/.config/ferret')
    expect(sent.body).toContain('C:\\Users\\<user>\\AppData')
    expect(sent.body).not.toMatch(/@octocat/)
    expect(sent.body).toContain('@\u200boctocat')
    expect(sent.body).toContain('#\u200b12')
    expect(sent.title).toBe('crash for @\u200boctocat at /Users/<user>')
  })

  it('当たった規則の名前だけを返す（中身は返さない）', () => {
    const r = redact(`x ${GH_TOKEN_LIKE} y`)
    expect(r.hits).toEqual(['github'])
    expect(r.text).toBe('x [REDACTED token] y')
    // 前の文字を問わず崩す（owner/repo@sha・octo#1 も参照になるため。security-4 [11]）。見た目は同じ
    expect(neutralizeMentions('a@b octo#1 GH-2 GitHub.com')).toBe('a@\u200bb octo#\u200b1 GH-\u200b2 GitHub\u200b.com')
  })
})

describe('feedback-relay: 頻度の上限と連投', () => {
  it('同じインストール ID は1時間に5件まで。6件目は 429 rate_limited と Retry-After', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    for (let i = 0; i < 5; i++) {
      const r = await send(env, gh, post(form({ title: `issue ${i}` }), { 'cf-connecting-ip': `198.51.100.${i}` }), t0 + i * 1000)
      expect(r.res.status).toBe(201)
    }
    const sixth = await send(env, gh, post(form({ title: 'issue 6' }), { 'cf-connecting-ip': '198.51.100.99' }), t0 + 10_000)
    expect(sixth.res.status).toBe(429)
    expect(sixth.json).toEqual({ ok: false, code: 'rate_limited' })
    expect(Number(sixth.res.headers.get('retry-after'))).toBeGreaterThan(3500)
    expect(gh.calls).toHaveLength(5)
    // 1時間たてば通る
    const later = await send(env, gh, post(form({ title: 'issue 7' }), { 'cf-connecting-ip': '198.51.100.98' }), t0 + 60 * 60 * 1000 + 1)
    expect(later.res.status).toBe(201)
  })

  it('同じ IP はインストール ID を変えても1時間に5件まで', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    const ids = [INSTALL, INSTALL2, ...[1, 2, 3, 4].map((i) => `0000000${i}-0000-4000-8000-000000000000`)]
    const statuses = []
    for (const [i, id] of ids.entries()) statuses.push((await send(env, gh, post(form({ title: `t${i}`, installId: id })), t0 + i)).res.status)
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429])
  })

  it('1日に20件まで（1時間に5件ずつ送っても、21件目は断る）', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) {
      const hour = Math.floor(i / 5)
      statuses.push((await send(env, gh, post(form({ title: `d${i}` })), t0 + hour * 60 * 60 * 1000 + (i % 5) * 1000 + hour)).res.status)
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true)
    expect(statuses[20]).toBe(429)
  })

  it('同じ題名と本文は、送り主が違っても 24時間 409 duplicate', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    expect((await send(env, gh, post(form()), t0)).res.status).toBe(201)
    const dup = await send(env, gh, post(form({ installId: INSTALL2, body: '  It stops   after 10 seconds. ' }), { 'cf-connecting-ip': '192.0.2.1' }), t0 + 1000)
    expect(dup.res.status).toBe(409)
    expect(dup.json).toEqual({ ok: false, code: 'duplicate' })
    expect(gh.calls).toHaveLength(1)
  })

  it('インストール ID が無ければ IP と全体だけで数える（IP ごとの1時間5件は効く）', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await send(env, gh, post(form({ title: `n${i}`, installId: undefined })), 1_800_000_000_000 + i)).res.status)
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429])
    expect([...limiters.keys()].some((n) => n.startsWith('install:'))).toBe(false)
  })

  it('IP とインストール ID はそのまま保存しない（Durable Object の名前は HMAC、中身は時刻だけ）', async () => {
    const { env, limiters } = fakeEnv()
    await send(env, fakeGithub(), post(form()))
    const names = [...limiters.keys()]
    expect(names.length).toBe(6) // preparse・attempt・ip・install・global・dup
    for (const name of names) {
      expect(name).not.toContain(IP)
      expect(name).not.toContain(INSTALL)
      expect(name).toMatch(/^(attempt|ip|install|dup):[0-9a-f]{64}$|^(global|preparse)$/)
    }
    for (const { storage } of limiters.values()) {
      for (const [k, v] of storage.data) {
        expect(k).toBe('times')
        expect((v as unknown[]).every((t) => typeof t === 'number')).toBe(true)
      }
    }
  })

  it('decide: 窓の中の件数で判定し、いちばん古いものが出るまでの秒数を返す。24時間より前の記録は捨てる', () => {
    const w = [{ windowMs: 1000, max: 2 }]
    expect(decide([], 'hit', w, 10_000)).toEqual({ times: [10_000], result: { allowed: true, retryAfterSec: 0 } })
    const full = decide([9_500, 9_800], 'hit', w, 10_000)
    expect(full.result).toEqual({ allowed: false, retryAfterSec: 1 })
    expect(full.times).toEqual([9_500, 9_800])
    expect(decide([9_500], 'peek', [{ windowMs: 1000, max: 1 }], 10_000).times).toEqual([9_500])
    expect(decide([1], 'record', w, KEEP_MS + 10).times).toEqual([KEEP_MS + 10])
  })

  it('alarm: 24時間たった記録を消し、空ならストレージごと消す', async () => {
    const storage = new MemoryStorage()
    await storage.put('times', [Date.now() - KEEP_MS - 1])
    await new FeedbackLimiter({ storage }).alarm()
    expect(storage.data.size).toBe(0)
  })
})

describe('feedback-relay: 画像を返す', () => {
  it('置いた画像を、名前から決めた種類と nosniff・sandbox の CSP で返す。形の違う名前は 404', async () => {
    const { env, media } = fakeEnv()
    await send(env, fakeGithub(), post(form({}, [{ bytes: png() }])))
    const key = [...media.keys()][0]
    const res = await handle(new Request(`${BASE}/v1/media/${key.slice(3)}`), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(media.get(key)!.bytes)
    for (const bad of ['../secret.png', `${'0'.repeat(31)}.png`, `${'0'.repeat(32)}.svg`, `${'0'.repeat(32)}.png`]) {
      expect((await handle(new Request(`${BASE}/v1/media/${bad}`), env)).status).toBe(404)
    }
  })
})

/* ── security-3（Codex の3回目のスキャン）[3][4][7] ─────────────────── */

describe('security-3 [3][4][7] 中継の上限は、重い処理・副作用・広い枠より前に、1回の呼び出しで決める', () => {
  const globalCount = (limiters: ReturnType<typeof fakeEnv>['limiters']) => ((limiters.get('global')?.storage.data.get('times') as number[] | undefined) ?? []).length

  it('security-3 [3] 送り主の枠で断られた要求は、全体の枠（global）を減らさない', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    // 同じインストール ID で5件（IP は毎回変える）→ 6件目以降はインストール ID の枠で断られる
    for (let i = 0; i < 5; i++) expect((await send(env, gh, post(form({ title: `ok ${i}` }), { 'cf-connecting-ip': `198.51.100.${i}` }), t0 + i)).res.status).toBe(201)
    expect(globalCount(limiters)).toBe(5)
    for (let i = 0; i < 20; i++) {
      const r = await send(env, gh, post(form({ title: `denied ${i}` }), { 'cf-connecting-ip': `203.0.113.${i + 10}` }), t0 + 100 + i)
      expect(r.res.status).toBe(429)
    }
    expect(globalCount(limiters)).toBe(5)
    // 断られた IP の枠も残らない（予約を戻す）。同じ IP から別のインストール ID なら通る
    expect((await send(env, gh, post(form({ title: 'other install', installId: INSTALL2 }), { 'cf-connecting-ip': '203.0.113.10' }), t0 + 500)).res.status).toBe(201)
  })

  it('security-3 [3] 全体の枠で断られたら、先に取った IP・インストール ID の予約を戻す', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    // 全体の枠を埋めておく
    const full = Array.from({ length: 200 }, (_, i) => t0 - 1000 + i)
    limiters.set('global', { storage: Object.assign(new MemoryStorage(), { data: new Map<string, unknown>([['times', full]]) }), obj: undefined as never })
    limiters.get('global')!.obj = new FeedbackLimiter({ storage: limiters.get('global')!.storage })
    expect((await send(env, gh, post(form()), t0)).res.status).toBe(429)
    for (const [name, { storage }] of limiters) {
      if (/^(ip|install):/.test(name)) expect((storage.data.get('times') as number[] | undefined) ?? []).toEqual([])
    }
    expect(gh.calls).toHaveLength(0)
  })

  it('security-3 [4] 送信の枠を使い切った IP の要求は、本文を読む前に断る', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    for (let i = 0; i < 5; i++) expect((await send(env, gh, post(form({ title: `t${i}`, installId: undefined })), t0 + i)).res.status).toBe(201)
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024 * 1024))
        if (pulled >= 8) controller.close()
      }
    })
    const req = new Request(`${BASE}/v1/issues`, {
      method: 'POST', body, duplex: 'half',
      headers: { 'cf-connecting-ip': IP, 'content-type': 'multipart/form-data; boundary=x' }
    } as RequestInit)
    const r = await send(env, gh, req, t0 + 100)
    expect(r.res.status).toBe(429)
    // ReadableStream は最初の1塊を先に引くことがあるが、本文全体（8MB）は読まない
    expect(pulled).toBeLessThanOrEqual(1)
  })

  it('security-3 [4] 形の悪い要求も、本文を読む前の試みの上限に数える（全体の枠は食わない）', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push((await send(env, gh, post('not multipart', { 'content-type': 'text/plain' }), t0 + i)).res.status)
    expect(statuses.slice(0, 30).every((s) => s === 415)).toBe(true)
    expect(statuses[30]).toBe(429)
    expect(globalCount(limiters)).toBe(0)
    // 試みの上限は IP ごと。ほかの IP は通る
    expect((await send(env, gh, post(form(), { 'cf-connecting-ip': '192.0.2.50' }), t0 + 100)).res.status).toBe(201)
  })

  it('security-3 [7] 同時に来た同じ内容は、1件だけが画像の保存と Issue の作成に進む', async () => {
    const { env, media } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      send(env, gh, post(form({ installId: `0000000${i}-0000-4000-8000-000000000000` }, [{ bytes: png() }]), { 'cf-connecting-ip': `198.51.100.${i + 20}` }), t0 + i)))
    expect(results.map((r) => r.res.status).sort()).toEqual([201, 409, 409, 409, 409])
    expect(gh.calls).toHaveLength(1)
    expect(media.size).toBe(1)
  })

  it('security-3 [7] decide: 先に記録された後の時刻も数える（時計のそろわない同時の要求）', () => {
    const now = 1_800_000_000_000
    const dup = [{ windowMs: 24 * 60 * 60 * 1000, max: 1 }]
    expect(decide([now + 3], 'hit', dup, now).result.allowed).toBe(false)
    expect(decide([now + 3], 'hit', dup, now).times).toEqual([now + 3])
  })

  it('security-3 [7] Issue を作れなかったら内容の鍵を戻し、同じ内容を送り直せる', async () => {
    const { env } = fakeEnv()
    const t0 = 1_800_000_000_000
    expect((await send(env, fakeGithub(403), post(form()), t0)).res.status).toBe(502)
    expect((await send(env, fakeGithub(), post(form()), t0 + 1000)).res.status).toBe(201)
  })

  it('security-3 [3][7] decide: release は hit で数えた同じ時刻の1件だけを取り消す', () => {
    const now = 1_800_000_000_000
    expect(decide([now - 5, now, now], 'release', [], now).times).toEqual([now - 5, now])
    expect(decide([now - 5], 'release', [], now).times).toEqual([now - 5])
  })
})

/* ── security-4（Codex の4回目のスキャン）[4][8][11][12] ─────────────────── */

describe('security-4 [4] 全体の枠（global）は Issue を作った分だけ数える', () => {
  const count = (limiters: ReturnType<typeof fakeEnv>['limiters'], name: string) => ((limiters.get(name)?.storage.data.get('times') as number[] | undefined) ?? []).length

  it('security-4 [4] 別々の送り主からの重複は、全体の枠を作った1件分しか減らさない', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    expect((await send(env, gh, post(form()), t0)).res.status).toBe(201)
    for (let i = 0; i < 30; i++) {
      const r = await send(env, gh, post(form({ installId: `0000000${i % 10}-0000-4000-8000-00000000000${Math.floor(i / 10)}` }), { 'cf-connecting-ip': `198.51.100.${i + 1}` }), t0 + 10 + i)
      expect(r.res.status).toBe(409)
    }
    expect(count(limiters, 'global')).toBe(1)
    expect(gh.calls).toHaveLength(1)
  })

  it('security-4 [4] 重複で断った要求は、送り主（IP・インストール ID）の枠も戻す', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    expect((await send(env, gh, post(form(), { 'cf-connecting-ip': '192.0.2.200' }), t0)).res.status).toBe(201)
    expect((await send(env, gh, post(form({ installId: INSTALL2 })), t0 + 1)).res.status).toBe(409)
    for (const [name, { storage }] of limiters) {
      if (/^(ip|install):/.test(name) && (storage.data.get('times') as number[] | undefined)?.includes(t0 + 1)) throw new Error(`${name} still holds the duplicate`)
    }
  })

  it('security-4 [4] 全体の枠で断ったら、取った内容の鍵も戻す（あとで同じ内容を送れる）', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    const storage = Object.assign(new MemoryStorage(), { data: new Map<string, unknown>([['times', Array.from({ length: 200 }, (_, i) => t0 - 1000 + i)]]) })
    limiters.set('global', { storage, obj: new FeedbackLimiter({ storage }) })
    expect((await send(env, gh, post(form()), t0)).res.status).toBe(429)
    for (const [name, { storage: s }] of limiters) if (name.startsWith('dup:')) expect((s.data.get('times') as number[] | undefined) ?? []).toEqual([])
    // 全体の枠が空いたら、同じ内容が通る
    storage.data.set('times', [])
    expect((await send(env, gh, post(form(), { 'cf-connecting-ip': '192.0.2.201' }), t0 + 2000)).res.status).toBe(201)
  })

  it('security-4 [4] GitHub が作らなかった（4xx）ときは、全体の枠と内容の鍵を戻す', async () => {
    const { env, limiters } = fakeEnv()
    const t0 = 1_800_000_000_000
    expect((await send(env, fakeGithub(422), post(form()), t0)).res.status).toBe(502)
    expect(count(limiters, 'global')).toBe(0)
    expect((await send(env, fakeGithub(), post(form()), t0 + 1000)).res.status).toBe(201)
  })
})

describe('security-4 [8] 送信元を増やしても、本文を読む前の上限と limiter の数は全体で決まった数まで', () => {
  const v6 = (i: number) => `2001:db8:${(i + 1).toString(16)}::1`

  it('security-4 [8] IPv6 は /64 にまとめる（同じ /64 の別のアドレスは同じ送り主）。IPv4 はそのまま', () => {
    expect(sourceIdentity('2001:db8:1:2:aaaa::1')).toBe(sourceIdentity('2001:0DB8:0001:0002:ffff:ffff:ffff:fffe'))
    expect(sourceIdentity('2001:db8:1:2::1')).not.toBe(sourceIdentity('2001:db8:1:3::1'))
    expect(sourceIdentity('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(sourceIdentity('203.0.113.7')).toBe('203.0.113.7')
    expect(sourceIdentity('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(sourceIdentity('not an ip')).toBe('unknown')
  })

  it('security-4 [8] 同じ /64 からアドレスを変えて送っても、試みの上限は1つの送り主として数える', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push((await send(env, gh, post('x', { 'content-type': 'text/plain', 'cf-connecting-ip': `2001:db8:5:6::${(i + 1).toString(16)}` }), 1_800_000_000_000 + i)).res.status)
    expect(statuses.slice(0, 30).every((s) => s === 415)).toBe(true)
    expect(statuses[30]).toBe(429)
  })

  it('security-4 [8] 全体の前処理の枠が尽きたら、本文を読まずに断り、送り主ごとの limiter も作らない', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    const max = Math.min(...PREPARSE_LIMITS.map((w) => w.max))
    for (let i = 0; i < max; i++) await send(env, gh, post('x', { 'content-type': 'text/plain', 'cf-connecting-ip': v6(i) }), t0 + i)
    // 送り主ごとの limiter（試みの数・送信の数）は、どちらの種類も全体の前処理の枠の数まで
    const perSource = () => [...limiters.keys()].filter((n) => /^(attempt|ip):/.test(n)).length
    for (const kind of ['attempt', 'ip']) expect([...limiters.keys()].filter((n) => n.startsWith(`${kind}:`)).length).toBeLessThanOrEqual(max)
    const before = perSource()
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024 * 1024))
        if (pulled >= 8) controller.close()
      }
    })
    const req = new Request(`${BASE}/v1/issues`, {
      method: 'POST', body, duplex: 'half',
      headers: { 'cf-connecting-ip': '2001:db8:ffff::1', 'content-type': 'multipart/form-data; boundary=x' }
    } as RequestInit)
    const r = await send(env, gh, req, t0 + max + 1)
    expect(r.res.status).toBe(429)
    expect(pulled).toBeLessThanOrEqual(1)
    expect(perSource()).toBe(before)
  })

  it('security-4 [8] 送信元を際限なく変えても、limiter の数は全体の前処理の枠の分までしか増えない', async () => {
    const { env, limiters } = fakeEnv()
    const gh = fakeGithub()
    const t0 = 1_800_000_000_000
    const max = Math.min(...PREPARSE_LIMITS.map((w) => w.max))
    for (let i = 0; i < max + 200; i++) await send(env, gh, post('x', { 'content-type': 'text/plain', 'cf-connecting-ip': v6(i) }), t0 + i)
    expect([...limiters.keys()].filter((n) => n.startsWith('attempt:')).length).toBeLessThanOrEqual(max)
  })
})

describe('security-4 [11] 送られた本文は GitHub の相互参照・メンション・リンクにならない', () => {
  const attacks = [
    'see octo/repo#123 and octo#77',
    'GH-123 and gh-45',
    'https://github.com/octo/repo/issues/5',
    '[click](https://github.com/octo/repo/pull/6)',
    '<a href="https://github&#46;com/octo/repo/issues/7">x</a>',
    '[rel](../../issues/8)',
    'www.github.com/octo/repo/issues/9',
    'cc @octocat and #12 and octo/repo@abcdef1',
    '```\nbreak out\n```\n@octocat #13',
    '~~~\n@octocat\n~~~',
    '````` five backticks ````` #14'
  ]

  /** 本文のうち、コードブロックの外（GitHub が参照・リンクとして読む部分）。フェンスは開きと同じ長さ以上の閉じでだけ閉じる */
  function liveText(markdown: string): string {
    const live: string[] = []
    let fence: string | null = null
    for (const line of markdown.split('\n')) {
      if (fence) {
        if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null
        continue
      }
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (open) {
        fence = open[1]!
        continue
      }
      live.push(line)
    }
    // 閉じていないフェンスは文書の終わりまでコード（CommonMark）。外の部分だけを返す
    return live.join('\n')
  }

  it('security-4 [11] 本文はコードブロック（中の最長のバッククォートより長いフェンス）に入れ、外には参照の形が残らない', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    const body = attacks.join('\n\n')
    expect((await send(env, gh, post(form({ body }))).then((r) => r.res.status))).toBe(201)
    const sent = JSON.parse(String(gh.calls[0].init.body)) as { title: string; body: string }
    const live = liveText(sent.body)
    for (const pattern of [/#\d/, /GH-\d/i, /github\.com/i, /github&#/i, /@octocat/, /\]\(/, /<a /i, /\/issues\//]) expect(live).not.toMatch(pattern)
    // 本文そのものは読める形でコードブロックの中にある
    expect(sent.body).toContain('GH-')
    expect(sent.body).toContain('octo/repo')
  })

  it('security-4 [11] literalBlock: フェンスは中のいちばん長いバッククォートより長い', () => {
    expect(literalBlock('plain')).toBe('```text\nplain\n```')
    expect(literalBlock('a ```` b')).toBe('`````text\na ```` b\n`````')
  })

  it('security-4 [11] 題名の相互参照（owner/repo#1・GH-1・github.com の URL・@）も崩す', async () => {
    const { env } = fakeEnv()
    const gh = fakeGithub()
    await send(env, gh, post(form({ title: 'crash octo/repo#123 GH-9 https://github.com/octo/repo/issues/1 @octocat' })))
    const { title } = JSON.parse(String(gh.calls[0].init.body)) as { title: string }
    for (const pattern of [/#\d/, /GH-\d/i, /github\.com/i, /@octocat/]) expect(title).not.toMatch(pattern)
  })
})

describe('security-4 [12] GitHub が作ったか分からない失敗では、内容の鍵と画像を残し、2件目を作らない', () => {
  /** POST は GitHub に届いて Issue ができたが、応答が失われる */
  function lostResponse(kind: 'throw' | 'garbled' | '5xx') {
    const calls: GhCall[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (kind === 'throw') throw new TypeError('Network connection lost.')
      if (kind === 'garbled') return new Response('{"number": 5, "html_url": ', { status: 201 })
      return new Response('upstream timeout', { status: 504 })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  for (const kind of ['throw', 'garbled', '5xx'] as const) {
    it(`security-4 [12] 送ったあとの失敗（${kind}）は upstream_pending。画像と内容の鍵を残し、送り直しは 409 duplicate`, async () => {
      const { env, media } = fakeEnv()
      const gh = lostResponse(kind)
      const t0 = 1_800_000_000_000
      const first = await send(env, gh as unknown as ReturnType<typeof fakeGithub>, post(form({}, [{ bytes: png() }])), t0)
      expect(first.json).toEqual({ ok: false, code: 'upstream_pending' })
      // Issue に貼られたかもしれない画像は消さない
      expect(media.size).toBe(1)
      const retry = await send(env, fakeGithub(), post(form({}, [{ bytes: png() }]), { 'cf-connecting-ip': '192.0.2.77' }), t0 + 1000)
      expect(retry.res.status).toBe(409)
      expect(gh.calls).toHaveLength(1)
    })
  }

  it('security-4 [12] 送る前の失敗（画像を置けない）は upstream_failed で、内容の鍵を戻す', async () => {
    const { env } = fakeEnv()
    const t0 = 1_800_000_000_000
    const put = env.MEDIA.put
    env.MEDIA.put = async () => { throw new Error('r2 down') }
    expect((await send(env, fakeGithub(), post(form({}, [{ bytes: png() }])), t0)).json).toEqual({ ok: false, code: 'upstream_failed' })
    env.MEDIA.put = put
    expect((await send(env, fakeGithub(), post(form({}, [{ bytes: png() }])), t0 + 1000)).res.status).toBe(201)
  })
})
