/**
 * 判定モデルの中継の合言葉の寿命（レポート [11]）。
 * ターミナルが閉じた・判定を無効にした・期限が過ぎたら 401、提供元・キー・モデルの変更では切らないことを、127.0.0.1 の中継で確かめる
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DECISION_ENV, type DecisionPreferences } from '@shared/decision'
import { DecisionRelay, RELAY_MAX_CONCURRENT_PER_TOKEN, RELAY_TOKEN_MAX_AGE_MS } from '../../src/main/decision/relay'
import { DecisionService } from '../../src/main/decision/service'

/** 中継が受け付ける最小の System One の依頼（security-7 [7]。形の違う本文は送らずに断る） */
const SYSTEM_ONE_BODY = JSON.stringify({ model: 'm', state: 's', questions: { ok: { type: 'noul' } } })

let upstream: Server
let upstreamUrl = ''

beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/systemone`
})

afterAll(async () => {
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

const post = async (url: string) => (await fetch(url, { method: 'POST', body: SYSTEM_ONE_BODY })).status

describe('security-2 [6] 中継の合言葉', () => {
  it('ターミナルが閉じたら、そのターミナルの合言葉だけが無効になる', async () => {
    const relay = new DecisionRelay({ upstream: async () => ({ url: upstreamUrl, headers: {}, provider: 'p', model: 'm', timeoutMs: 5000 }) })
    await relay.start()
    const closed = relay.urlFor(relay.issue({ sessionId: 't1' }))
    const open = relay.urlFor(relay.issue({ sessionId: 't2' }))
    expect(await post(closed)).toBe(200)
    relay.revokeSession('t1')
    expect(await post(closed)).toBe(401)
    expect(await post(open)).toBe(200)
    relay.revokeAll()
    expect(await post(open)).toBe(401)
    await relay.stop()
  })

  it('出してから期限（24時間）が過ぎた合言葉は、使い続けていても断る', async () => {
    let now = Date.parse('2026-10-03T00:00:00Z')
    const relay = new DecisionRelay({ upstream: async () => ({ url: upstreamUrl, headers: {}, provider: 'p', model: 'm', timeoutMs: 5000 }), now: () => new Date(now) })
    await relay.start()
    const url = relay.urlFor(relay.issue())
    expect(RELAY_TOKEN_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
    now += RELAY_TOKEN_MAX_AGE_MS - 1000
    expect(await post(url)).toBe(200)
    now += 2000
    expect(await post(url)).toBe(401)
    // 新しく出した合言葉は使える（ターミナルを開き直した）
    expect(await post(relay.urlFor(relay.issue()))).toBe(200)
    await relay.stop()
  })
})

describe('security-2 [6] 1つの合言葉で同時に送れる数', () => {
  it('上限を超えた同時の依頼は 429 で断り、終わればまた送れる', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slow = createServer((req, res) => {
      req.resume()
      void gate.then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/`
    const relay = new DecisionRelay({ upstream: async () => ({ url: slowUrl, headers: {}, provider: 'p', model: 'm', timeoutMs: 5000 }) })
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue())
      const pending = Array.from({ length: RELAY_MAX_CONCURRENT_PER_TOKEN }, () => fetch(url, { method: 'POST', body: SYSTEM_ONE_BODY }))
      await new Promise((r) => setTimeout(r, 100))
      expect(await post(url)).toBe(429)
      // ほかの合言葉は影響を受けない
      const other = relay.urlFor(relay.issue())
      const otherReq = fetch(other, { method: 'POST', body: SYSTEM_ONE_BODY })
      release()
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(RELAY_MAX_CONCURRENT_PER_TOKEN).fill(200))
      expect((await otherReq).status).toBe(200)
      expect(await post(url)).toBe(200)
    } finally {
      await relay.stop()
      slow.closeAllConnections()
      await new Promise<void>((resolve) => slow.close(() => resolve()))
    }
  })
})

describe('security-2 [6] 判定の設定と合言葉', () => {
  const base: DecisionPreferences = { enabled: true, preset: 'custom', model: 'clef-flash', authScheme: 'none' }

  it('ターミナルの ID を結び付け、閉じたら revokeSession で無効にできる', async () => {
    const prefs: DecisionPreferences = { ...base, endpoint: upstreamUrl }
    const service = new DecisionService({ prefs: () => prefs, readKey: async () => undefined, getEnv: () => undefined, onCall: () => {} })
    const url = (await service.launchEnv({ sessionId: 't9' }))[DECISION_ENV.url]!
    expect(await post(url)).toBe(200)
    service.revokeSession('t9')
    expect(await post(url)).toBe(401)
    await service.stop()
  })

  it('提供元・接続先・キー・モデルを変えたら合言葉を切る（security-5 [4]。同じ設定の sync では切らない）', async () => {
    let prefs: DecisionPreferences = { ...base, endpoint: upstreamUrl }
    const service = new DecisionService({ prefs: () => prefs, readKey: async () => undefined, getEnv: () => undefined, onCall: () => {} })
    const url = (await service.launchEnv())[DECISION_ENV.url]!
    await service.sync()
    expect(await post(url)).toBe(200)
    prefs = { ...prefs, endpoint: `${upstreamUrl}?other=1`, apiKeyEnv: 'OTHER_KEY' }
    await service.sync()
    expect(await post(url)).toBe(401)
    const next = (await service.launchEnv())[DECISION_ENV.url]!
    prefs = { ...prefs, model: 'clef' }
    await service.sync()
    expect(await post(next)).toBe(401)
    await service.stop()
  })

  it('無効にしてから有効に戻しても、前の合言葉は使えない', async () => {
    let prefs: DecisionPreferences = { ...base, endpoint: upstreamUrl }
    const service = new DecisionService({ prefs: () => prefs, readKey: async () => undefined, getEnv: () => undefined, onCall: () => {} })
    const url = (await service.launchEnv({ sessionId: 't1' }))[DECISION_ENV.url]!
    prefs = { ...prefs, enabled: false }
    await service.sync()
    prefs = { ...prefs, enabled: true }
    await service.sync()
    const old = new URL(url)
    const port = service.port!
    expect(await post(`http://127.0.0.1:${port}${old.pathname}${old.search}`)).toBe(401)
    await service.stop()
  })
})
