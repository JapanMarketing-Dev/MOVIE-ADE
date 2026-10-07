import { describe, expect, it, vi } from 'vitest'
import { DECISION_PRESETS, DECISION_PRESET_IDS, applyDecisionPreset, decisionModelSupportsImages, decisionSetupGuide, resolveDecision, DEFAULT_DECISION_PREFERENCES } from '@shared/decision'
import { DECISION_QUESTIONS_JSON } from '../../src/main/pipeline/feedback'
import { decisionWireFor, fromOpenAiDecisions, toImageDataUrl, toOpenAiDecisions } from '../../src/main/decision/openaiDecisions'
import { DecisionRelay } from '../../src/main/decision/relay'
import { checkDecision } from '../../src/main/decision/check'
import { budgetPricing } from '../../src/main/decision/requestBound'
import type { ApiCallRecord } from '@shared/apiUsage'

const OPENAI_URL = 'https://api.openai.com/v1/decisions'
const questions = JSON.parse(DECISION_QUESTIONS_JSON) as Record<string, unknown>

describe('OpenAI Decisions API のプリセット', () => {
  it('jev などと同じ選択肢に並び、OpenAI のキー・画像あり・data URL・入力だけの単価で埋まる', () => {
    expect(DECISION_PRESET_IDS).toContain('openai')
    expect(DECISION_PRESET_IDS.indexOf('openai')).toBe(DECISION_PRESET_IDS.indexOf('typesafe') + 1)
    const def = DECISION_PRESETS.openai
    expect(def).toMatchObject({ vendor: 'openai', endpoint: OPENAI_URL, model: 'gpt-6-luna', images: true, imageFormat: 'data-uri', authScheme: 'bearer', apiKeyEnv: 'OPENAI_API_KEY' })
    const prefs = applyDecisionPreset({ ...DEFAULT_DECISION_PREFERENCES, enabled: true }, 'openai')
    const resolved = resolveDecision(prefs)
    expect(resolved).toMatchObject({ url: OPENAI_URL, model: 'gpt-6-luna', images: true, imageFormat: 'data-uri', missing: [] })
    expect(resolved.pricing).toEqual({ inputPer1M: 0.1, outputPer1M: 0 })
    expect(budgetPricing(resolved.url, resolved.pricing)).toEqual({ inputPer1M: 0.1, outputPer1M: 0 })
    expect(decisionModelSupportsImages('gpt-6-luna')).toBe(true)
    expect(decisionSetupGuide(prefs, 'OpenAI')).toMatchObject({ keyRequired: true, envVar: 'OPENAI_API_KEY' })
  })

  it('/v1/decisions の接続先だけを OpenAI の形にする', () => {
    expect(decisionWireFor(OPENAI_URL)).toBe('openai-decisions')
    expect(decisionWireFor('https://proxy.example/openai/v1/decisions/')).toBe('openai-decisions')
    expect(decisionWireFor('http://localhost:11434/v1/systemone')).toBe('systemone')
    expect(decisionWireFor('not a url')).toBe('systemone')
  })
})

describe('System One → OpenAI の依頼', () => {
  it('noul は predicate（criteria を instructions に足す）、choice は choices、画像は BEFORE / AFTER の名前付きの data URL', () => {
    const out = toOpenAiDecisions({ model: 'x', state: 'Finding 1 / Done when: blue', questions, images: ['iVBORw0KGgoAAA', 'data:image/jpeg;base64,/9j/AA'] }, 'gpt-6-luna')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const body = out.body as { model: string; input: Array<{ role: string; content: Array<Record<string, string>> }>; questions: Array<Record<string, unknown>> }
    expect(body.model).toBe('gpt-6-luna')
    expect(body.input[0]!.role).toBe('user')
    expect(body.input[0]!.content).toEqual([
      { type: 'input_text', text: 'Finding 1 / Done when: blue' },
      { type: 'input_text', text: 'BEFORE image:' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAA' },
      { type: 'input_text', text: 'AFTER image:' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AA' }
    ])
    const [done, status] = body.questions
    expect(done).toMatchObject({ type: 'predicate', name: 'done' })
    expect(done!.instructions).toContain('Answer true when: The AFTER screen clearly shows')
    expect(done!.instructions).toContain('Answer false when:')
    expect(status).toMatchObject({ type: 'choice', name: 'status' })
    expect((status!.choices as Array<{ value: string }>).map((c) => c.value)).toEqual(['done', 'partial', 'not_done', 'cannot_tell'])
    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'questions'])
  })

  it('画像が無ければ input は文のまま。名前に使えない鍵は q<n> にして応答で戻す', () => {
    const out = toOpenAiDecisions({ state: 's', questions: { 'is ok?': { type: 'noul', instructions: 'ok?' } } }, 'm')
    expect(out.ok && out.body.input).toBe('s')
    expect(out.ok && out.names).toEqual({ q1: 'is ok?' })
    const back = fromOpenAiDecisions({ answers: [{ type: 'predicate', name: 'q1', probability: 0.8 }] }, out.ok ? out.names : {})
    expect(back).toEqual({ answers: { 'is ok?': { type: 'noul', noul: 0.8 } } })
  })

  it('写せない種類・答えの足りない choice は断る', () => {
    expect(toOpenAiDecisions({ state: 's', questions: { a: { type: 'rank' } } }, 'm').ok).toBe(false)
    expect(toOpenAiDecisions({ state: 's', questions: { a: { type: 'choice', criteria: { only: 'x' } } } }, 'm').ok).toBe(false)
    const score = toOpenAiDecisions({ state: 's', questions: { sev: { type: 'score', criteria: { low: 'a', high: 'b' } } } }, 'm')
    expect(score.ok && score.body.questions).toEqual([{ type: 'score', name: 'sev', instructions: '', levels: [{ label: 'low', description: 'a' }, { label: 'high', description: 'b' }] }])
  })

  it('ただの base64 は先頭で種類を見て data URL にする', () => {
    expect(toImageDataUrl('iVBORw0KGgoX')).toBe('data:image/png;base64,iVBORw0KGgoX')
    expect(toImageDataUrl('/9j/4AAQ')).toBe('data:image/jpeg;base64,/9j/4AAQ')
    expect(toImageDataUrl('UklGRxx')).toBe('data:image/webp;base64,UklGRxx')
    expect(toImageDataUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
  })
})

describe('OpenAI → System One の応答', () => {
  it('predicate は noul、choice は choice・confidence・probabilities、usage はそのまま', () => {
    const back = fromOpenAiDecisions({
      answers: [
        { type: 'predicate', name: 'done', probability: 0.92 },
        { type: 'choice', name: 'status', choice: 'done', confidence: 0.81, probabilities: [{ value: 'done', probability: 0.9 }, { value: 'partial', probability: 0.1 }] },
        { type: 'score', name: 'sev', score: 1.1, confidence: 0.93, probabilities: [{ label: 'Cosmetic', probability: 0.2 }] }
      ],
      usage: { input_tokens: 1200 }
    }, { done: 'done', status: 'status', sev: 'sev' })
    expect(back).toEqual({
      answers: {
        done: { type: 'noul', noul: 0.92 },
        status: { type: 'choice', choice: 'done', confidence: 0.81, probabilities: { done: 0.9, partial: 0.1 } },
        sev: { type: 'score', score: 1.1, confidence: 0.93, probabilities: { Cosmetic: 0.2 } }
      },
      usage: { input_tokens: 1200 }
    })
  })

  it('answers が配列でない（エラーの本文）なら写さない', () => {
    expect(fromOpenAiDecisions({ error: { message: 'bad key' } }, {})).toBeNull()
    expect(fromOpenAiDecisions(null, {})).toBeNull()
  })
})

describe('中継と接続の確認', () => {
  const okAnswer = { answers: [{ type: 'predicate', name: 'done', probability: 0.91 }, { type: 'choice', name: 'status', choice: 'done', confidence: 0.7 }], usage: { input_tokens: 2000 } }

  it('中継は OpenAI の形で送り、System One の形で返し、入力の単価で費用を見積もる', async () => {
    const sent: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(Buffer.from(init!.body as Uint8Array).toString('utf8')), headers: init!.headers as Record<string, string> })
      return new Response(JSON.stringify(okAnswer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const calls: ApiCallRecord[] = []
    const relay = new DecisionRelay({
      upstream: async () => ({ url: OPENAI_URL, headers: { Authorization: 'Bearer sk-test' }, provider: 'openai', model: 'gpt-6-luna', pricing: { inputPer1M: 0.1, outputPer1M: 0 }, timeoutMs: 5000 }),
      onCall: (r) => calls.push(r),
      fetch: fetchImpl
    })
    await relay.start()
    try {
      const body = JSON.stringify({ model: 'other', state: 'Finding', questions, images: ['data:image/jpeg;base64,/9j/AA', 'data:image/jpeg;base64,/9j/BB'] })
      const res = await fetch(relay.urlFor(relay.issue({ projectId: 'p' })), { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ answers: { done: { type: 'noul', noul: 0.91 }, status: { type: 'choice', choice: 'done', confidence: 0.7 } }, usage: { input_tokens: 2000 } })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.url).toBe(OPENAI_URL)
      expect(sent[0]!.headers.Authorization).toBe('Bearer sk-test')
      expect(sent[0]!.body).toMatchObject({ model: 'gpt-6-luna', questions: [{ type: 'predicate', name: 'done' }, { type: 'choice', name: 'status' }] })
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0]).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', status: 200, images: 2, inputTokens: 2000, costSource: 'estimate' })
      expect(calls[0]!.costUsd).toBeCloseTo(0.0002, 8)
    } finally {
      await relay.stop()
    }
  })

  it('写せない依頼は送らずに 400、エラーの応答は変えずに返す', async () => {
    let reply = new Response('{"error":{"message":"Incorrect API key"}}', { status: 401, headers: { 'content-type': 'application/json' } })
    const fetchImpl = vi.fn(async () => reply) as unknown as typeof fetch
    const relay = new DecisionRelay({ upstream: async () => ({ url: OPENAI_URL, headers: {}, provider: 'openai', model: 'gpt-6-luna', timeoutMs: 5000 }), fetch: fetchImpl })
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue())
      const bad = await fetch(url, { method: 'POST', body: JSON.stringify({ model: 'm', state: 's', questions: { a: { type: 'rank' } } }) })
      expect(bad.status).toBe(400)
      expect(fetchImpl).not.toHaveBeenCalled()
      const res = await fetch(url, { method: 'POST', body: JSON.stringify({ model: 'm', state: 's', questions: { ok: { type: 'noul' } } }) })
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('{"error":{"message":"Incorrect API key"}}')
      reply = new Response('x')
    } finally {
      await relay.stop()
    }
  })

  it('「接続を確かめる」も OpenAI の形で送り、答えを読める', async () => {
    let sentBody: unknown
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init!.body))
      return new Response(JSON.stringify({ answers: [{ type: 'predicate', name: 'ok', probability: 0.99 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await checkDecision({ upstream: async () => ({ url: OPENAI_URL, headers: {}, provider: 'openai', model: 'gpt-6-luna', timeoutMs: 5000 }), fetch: fetchImpl })
    expect(result.ok).toBe(true)
    expect(sentBody).toMatchObject({ model: 'gpt-6-luna', input: 'The sky is blue on a clear day.', questions: [{ type: 'predicate', name: 'ok' }] })
  })
})
