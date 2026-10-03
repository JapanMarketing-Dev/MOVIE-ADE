import { describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { ApiCallRecord } from '@shared/apiUsage'
import { checkDecision, describeTestFailure, hasTestAnswer } from '../../src/main/decision/check'
import { DecisionService } from '../../src/main/decision/service'
import type { RelayUpstream } from '../../src/main/decision/relay'

setLocale('en')
const SECRET = 'sk-test-SECRET-value-1234567890'
const up: RelayUpstream = { url: 'https://decision.test/v1/systemone', headers: { Authorization: `Bearer ${SECRET}` }, provider: 'cloudflare', model: 'clef-flash', timeoutMs: 5000 }

describe('接続を確かめる', () => {
  it('同じ接続先・キーで1回送り、つながったらモデル名と時間を返し、記録に数える', async () => {
    const calls: ApiCallRecord[] = []
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: { answers: { ok: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 150, output_tokens: 0 } }, success: true })))
    const r = await checkDecision({ upstream: async () => up, onCall: (c) => calls.push(c), fetch })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/^Connected: clef-flash answered in \d+ ms\.$/)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(up.url)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'clef-flash', questions: { ok: { type: 'noul' } } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'decision', agent: 'connection test', provider: 'cloudflare', model: 'clef-flash', status: 200, images: 0, inputTokens: 150 })
    expect(JSON.stringify(calls[0])).not.toContain(SECRET)
  })

  it('失敗は利用者向けの短い文。キーも応答の本文も出さない', async () => {
    const body = JSON.stringify({ errors: [{ message: `bad token ${SECRET}` }], success: false })
    const r = await checkDecision({ upstream: async () => up, fetch: async () => new Response(body, { status: 401 }) })
    expect(r).toMatchObject({ ok: false, model: 'clef-flash' })
    expect(r.message).toContain('rejected the key')
    expect(r.message).not.toContain(SECRET)
    expect(r.message).not.toContain('bad token')
    expect(describeTestFailure(404, 'clef-flash')).toContain('ollama pull clef-flash')
    expect(describeTestFailure(413, 'm')).toContain('0.35.1')
    expect(describeTestFailure(429, 'm')).toContain('429')
    expect(describeTestFailure(529, 'm')).toContain('overloaded')
    expect(describeTestFailure(422, 'm')).toContain('422')
    expect(describeTestFailure(503, 'm')).toContain('server error')
  })

  it('届かない・答えの形が違う・設定が足りないときも、理由を返す（記録には status 0 で数える）', async () => {
    const calls: ApiCallRecord[] = []
    const down = await checkDecision({ upstream: async () => up, onCall: (c) => calls.push(c), fetch: async () => { throw new TypeError('fetch failed') } })
    expect(down).toMatchObject({ ok: false })
    expect(down.message).toContain('Could not reach')
    expect(calls[0]?.status).toBe(0)
    const html = await checkDecision({ upstream: async () => up, fetch: async () => new Response('<html>ok</html>') })
    expect(html.message).toContain('not in the System One format')
    const missing = await checkDecision({ upstream: async () => { throw new Error('Set the Cloudflare account ID (or CLOUDFLARE_ACCOUNT_ID) first.') } })
    expect(missing).toEqual({ ok: false, message: 'Set the Cloudflare account ID (or CLOUDFLARE_ACCOUNT_ID) first.' })
    expect(hasTestAnswer({ answers: { ok: { type: 'noul', noul: 0.4 } } })).toBe(true)
    expect(hasTestAnswer({ result: {}, success: false })).toBe(false)
  })

  it('E2E・テストでは本物を呼ばず決まった結果を返す。保存前の値（無効のまま）でも確かめられる', async () => {
    const fetch = vi.fn()
    const readKey = vi.fn(async () => SECRET)
    const service = new DecisionService({ prefs: () => undefined, readKey, getEnv: () => undefined, onCall: () => {}, fetch })
    const prefs = { enabled: false, preset: 'custom' as const, endpoint: 'https://decision.test/v1/systemone', model: 'jev-latest', authScheme: 'bearer' as const }
    const fake = await service.testConnection(prefs, { fake: true })
    expect(fake).toMatchObject({ ok: true, model: 'jev-latest', latencyMs: 0 })
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockResolvedValue(new Response(JSON.stringify({ answers: { ok: { type: 'noul', noul: 0.9 } } })))
    const real = await service.testConnection(prefs)
    expect(real.ok).toBe(true)
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: `Bearer ${SECRET}` })
    // Cloudflare の {account_id} が埋まらなければ送らない
    const cf = await service.testConnection({ enabled: false, preset: 'cloudflare' })
    expect(cf).toEqual({ ok: false, message: 'Set the Cloudflare account ID (or CLOUDFLARE_ACCOUNT_ID) first.' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
