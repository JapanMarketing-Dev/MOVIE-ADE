/**
 * OpenAI 以外の提供元（文字起こし・指摘の整理）のアダプタのテスト。
 * 要求の組み立てと応答の読み取りを、fetch を差し替えて確かめる。実際の API には送らない。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LLM_PROVIDER_PRESETS, STT_PROVIDER_PRESETS, isEndpointReady, isOrganizeRunnerId, resolveEndpoint } from '@shared/aiProviders'
import { setLocale } from '@shared/i18n'
import { CloudSttEngine, buildCloudSttRequest, checkSttEngine, createSttEngine, parseCloudSttResponse, type CloudSttOptions } from '../../src/main/pipeline/stt/cloud'
import { SttHttpError } from '../../src/main/pipeline/stt/engine'
import { sanitizeEndpointConfig } from '../../src/main/pipeline/stt/endpoint'
import { OpenAiSttEngine } from '../../src/main/pipeline/stt/openai'
import { writeWavFile } from '../../src/main/pipeline/stt/wav'
import { ApiLlmRunner, checkLlmRunner, schemaInstruction } from '../../src/main/pipeline/organize/runners/api'
import { RunnerError } from '../../src/main/pipeline/organize/runner'
import { refineWithLlm, buildDraftDocument } from '../../src/main/pipeline/decompose'
import { material } from './fixtures'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))
const { sanitize } = await import('../../src/main/settings')

beforeEach(() => setLocale('ja'))
afterEach(() => { vi.unstubAllGlobals() })

const WAV = Buffer.from('RIFF....WAVEfmt fake')
const base = (kind: CloudSttOptions['kind'], extra: Partial<CloudSttOptions> = {}): CloudSttOptions =>
  ({ kind, label: 'X', baseUrl: STT_PROVIDER_PRESETS[kind === 'azure-openai' ? 'azure' : kind === 'chat-audio' ? 'openrouter' : kind].baseUrl || 'https://res.openai.azure.com', model: 'm', apiKey: 'key-123', ...extra })

/** fetch の呼び出しを記録して、決まった応答を返す */
function mockFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return response() }))
  return calls
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('文字起こし: 要求の組み立て', () => {
  it('Azure OpenAI: デプロイ名と api-version を URL に、キーは api-key ヘッダー', () => {
    const r = buildCloudSttRequest(base('azure-openai', { baseUrl: 'https://my-res.openai.azure.com/', model: 'whisper-dep', language: 'ja' }), WAV, 'c.wav')
    expect(r.url).toBe('https://my-res.openai.azure.com/openai/deployments/whisper-dep/audio/transcriptions?api-version=2024-06-01')
    expect(r.headers['api-key']).toBe('key-123')
    expect(r.headers.Authorization).toBeUndefined()
    const form = r.body as FormData
    expect(form.getAll('language').map(String)).toEqual(['ja'])
    expect(form.getAll('model')).toEqual([])
  })

  it('Deepgram: 本文は WAV そのもの、Token 認証、言語が自動なら detect_language', async () => {
    const r = buildCloudSttRequest(base('deepgram', { model: 'nova-3' }), WAV, 'c.wav')
    const url = new URL(r.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://api.deepgram.com/v1/listen')
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('utterances')).toBe('true')
    expect(url.searchParams.get('detect_language')).toBe('true')
    expect(r.headers.Authorization).toBe('Token key-123')
    expect(r.headers['Content-Type']).toBe('audio/wav')
    expect(Buffer.from(await (r.body as Blob).arrayBuffer()).equals(WAV)).toBe(true)
    const ja = new URL(buildCloudSttRequest(base('deepgram', { language: 'ja' }), WAV, 'c.wav').url)
    expect(ja.searchParams.get('language')).toBe('ja')
  })

  it('ElevenLabs: multipart の model_id と xi-api-key。Base URL の /v1 は有っても無くても同じ', () => {
    const a = buildCloudSttRequest(base('elevenlabs', { model: 'scribe_v1', language: 'en' }), WAV, 'c.wav')
    const b = buildCloudSttRequest(base('elevenlabs', { baseUrl: 'https://api.elevenlabs.io' }), WAV, 'c.wav')
    expect(a.url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(b.url).toBe(a.url)
    expect(a.headers['xi-api-key']).toBe('key-123')
    const form = a.body as FormData
    expect(form.getAll('model_id').map(String)).toEqual(['scribe_v1'])
    expect(form.getAll('language_code').map(String)).toEqual(['en'])
  })

  it('Gemini: generateContent に音声を base64 で入れ、キーは x-goog-api-key（URL に入れない）', () => {
    const r = buildCloudSttRequest(base('gemini', { model: 'gemini-2.5-flash' }), WAV, 'c.wav')
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect(r.url).not.toContain('key-123')
    expect(r.headers['x-goog-api-key']).toBe('key-123')
    const body = JSON.parse(r.body as string)
    expect(body.contents[0].parts[1].inline_data).toEqual({ mime_type: 'audio/wav', data: WAV.toString('base64') })
  })

  it('OpenRouter（chat-audio）: chat/completions に input_audio を入れ、Bearer 認証', () => {
    const r = buildCloudSttRequest(base('chat-audio', { model: 'google/gemini-2.5-flash', headers: { 'HTTP-Referer': 'https://ade.example' } }), WAV, 'c.wav')
    expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(r.headers.Authorization).toBe('Bearer key-123')
    expect(r.headers['HTTP-Referer']).toBe('https://ade.example')
    const body = JSON.parse(r.body as string)
    expect(body.model).toBe('google/gemini-2.5-flash')
    expect(body.messages[0].content[1]).toEqual({ type: 'input_audio', input_audio: { data: WAV.toString('base64'), format: 'wav' } })
  })
})

describe('文字起こし: 応答の読み取り', () => {
  it('提供元ごとの形から本文（と時刻）を取り出す', () => {
    expect(parseCloudSttResponse('azure-openai', { text: 'こんにちは', duration: 2.5 })).toEqual({ text: 'こんにちは', durationSec: 2.5 })
    const dg = parseCloudSttResponse('deepgram', {
      metadata: { duration: 4 },
      results: { channels: [{ alternatives: [{ transcript: 'a b' }] }], utterances: [{ start: 0.5, end: 1.5, transcript: 'a' }, { start: 2, end: 3, transcript: 'b' }] },
    })
    expect(dg.text).toBe('a b')
    expect(dg.segments).toEqual([{ start: 0.5, end: 1.5, text: 'a' }, { start: 2, end: 3, text: 'b' }])
    expect(dg.durationSec).toBe(4)
    expect(parseCloudSttResponse('elevenlabs', { text: 'scribe', words: [] }).text).toBe('scribe')
    expect(parseCloudSttResponse('gemini', { candidates: [{ content: { parts: [{ text: 'gem' }, { text: 'ini' }] } }] }).text).toBe('gemini')
    expect(parseCloudSttResponse('chat-audio', { choices: [{ message: { content: 'routed' } }] }).text).toBe('routed')
    expect(parseCloudSttResponse('chat-audio', { choices: [{ message: { content: [{ type: 'text', text: 'parts' }] } }] }).text).toBe('parts')
    // 形が違っても落ちない
    expect(parseCloudSttResponse('gemini', null).text).toBe('')
  })
})

describe('文字起こし: エンジン', () => {
  let dir = ''
  let wavPath = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-cloud-'))
    wavPath = join(dir, 'c.wav')
    await writeWavFile(wavPath, new Int16Array(1600), 16_000)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const input = () => ({ wavPath, offsetMs: 10_000, speaker: 'self' as const, source: 'mic' as const, durationMs: 60_000 })

  it('時刻のある応答は区間ごと、録画の時刻へずらす', async () => {
    mockFetch(() => json({ results: { channels: [{ alternatives: [{ transcript: 'x' }] }], utterances: [{ start: 1, end: 2, transcript: 'はい' }] } }))
    const r = await new CloudSttEngine(base('deepgram')).transcribeChunk(input())
    expect(r.segments).toEqual([{ t0: 11_000, t1: 12_000, speaker: 'self', text: 'はい', source: 'mic' }])
    expect(r.commandLine).not.toContain('key-123')
  })

  it('提供元の概算の単価で上限を判定し、上限なしなら送る', async () => {
    const calls = mockFetch(() => json({ text: 'ok' }))
    // Deepgram は $0.0043/分。1分で $0.0043 > $0.004
    const limited = new CloudSttEngine(base('deepgram', { pricePerMinuteUsd: 0.0043, maxCostUsd: 0.004 }))
    await expect(limited.transcribeChunk(input())).rejects.toThrow('費用上限')
    expect(calls).toHaveLength(0)
    await new CloudSttEngine(base('deepgram', { pricePerMinuteUsd: null, maxCostUsd: null })).transcribeChunk({ ...input(), durationMs: 10 * 3600_000 })
    expect(calls).toHaveLength(1)
  })

  it('失敗は SttHttpError（状態コード付き）で、本文のキーは伏せる', async () => {
    mockFetch(() => new Response('bad key key-123-secret-value', { status: 401 }))
    const engine = new CloudSttEngine(base('elevenlabs', { apiKey: 'key-123-secret-value' }))
    const err = await engine.transcribeChunk(input()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SttHttpError)
    expect((err as SttHttpError).status).toBe(401)
    expect(String((err as Error).message)).not.toContain('key-123-secret-value')
  })

  it('createSttEngine: Groq は OpenAI 互換の入口へ Bearer で、追加のヘッダーも付ける', async () => {
    const calls = mockFetch(() => json({ text: 'groq' }))
    const engine = createSttEngine({ provider: 'groq', apiKey: 'gsk_abcdefghijklmnop', endpoint: { headers: { 'X-Team': 'ade' } }, maxCostUsd: null })
    expect(engine).toBeInstanceOf(OpenAiSttEngine)
    const r = await engine.transcribeChunk(input())
    expect(r.segments[0]?.text).toBe('groq')
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer gsk_abcdefghijklmnop', 'X-Team': 'ade' })
    expect((calls[0]!.init.body as FormData).getAll('model').map(String)).toEqual(['whisper-large-v3-turbo'])
  })

  it('createSttEngine: Mistral は file・model・language だけを送る', async () => {
    const calls = mockFetch(() => json({ text: 'voxtral' }))
    await createSttEngine({ provider: 'mistral', apiKey: 'mistral-key', language: 'ja', maxCostUsd: null }).transcribeChunk(input())
    const form = calls[0]!.init.body as FormData
    expect(calls[0]!.url).toBe('https://api.mistral.ai/v1/audio/transcriptions')
    expect(form.getAll('response_format')).toEqual([])
    expect(form.getAll('language').map(String)).toEqual(['ja'])
  })

  it('createSttEngine: キーが要るのに無ければ作らない（ほかのキーへ切り替えない）。互換はキーなしでよい', () => {
    expect(() => createSttEngine({ provider: 'deepgram' })).toThrow('APIキーが設定されていません')
    expect(() => createSttEngine({ provider: 'compatible', endpoint: { baseUrl: 'http://gpu:8000', model: 'whisper' } })).not.toThrow()
    expect(() => createSttEngine({ provider: 'azure', apiKey: 'k' })).toThrow()
  })

  it('接続の確認: 200 は届いた、401 は認証、つながらなければ URL を案内', async () => {
    mockFetch(() => json({ text: '' }))
    expect(await checkSttEngine({ provider: 'deepgram', apiKey: 'k' })).toMatchObject({ ok: true })
    mockFetch(() => new Response('{"err":"Invalid credentials"}', { status: 401 }))
    expect((await checkSttEngine({ provider: 'gemini', apiKey: 'k' })).message).toContain('APIキーを確認')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect((await checkSttEngine({ provider: 'elevenlabs', apiKey: 'k' })).message).toContain('接続できません')
    expect((await checkSttEngine({ provider: 'openrouter' })).message).toContain('APIキーが設定されていません')
  })
})

describe('準備の判定と設定の sanitize', () => {
  it('キー（要る場合）・Base URL・モデル名が揃っていれば使える', () => {
    expect(isEndpointReady(STT_PROVIDER_PRESETS.groq, undefined, true)).toBe(true)
    expect(isEndpointReady(STT_PROVIDER_PRESETS.groq, undefined, false)).toBe(false)
    expect(isEndpointReady(STT_PROVIDER_PRESETS.compatible, undefined, false)).toBe(false)
    expect(isEndpointReady(STT_PROVIDER_PRESETS.compatible, { baseUrl: 'http://gpu:8000', model: 'w' }, false)).toBe(true)
    expect(isEndpointReady(STT_PROVIDER_PRESETS.azure, { baseUrl: 'https://r.openai.azure.com' }, true)).toBe(false)
    expect(resolveEndpoint(LLM_PROVIDER_PRESETS.anthropic, { model: ' claude-sonnet-5-5 ' }).model).toBe('claude-sonnet-5-5')
  })

  it('接続先の上書き: 認証のヘッダーは捨て、タイムアウトは1秒〜10分に収める', () => {
    expect(sanitizeEndpointConfig({ baseUrl: 'https://x/v1', model: ' m ', timeoutMs: 999_999_999, apiVersion: '2024-10-21',
      headers: { 'HTTP-Referer': 'https://ade', Authorization: 'Bearer leak', 'x-api-key': 'leak', 'bad name': 'v', 'X-Multi': 'a\nb' } }))
      .toEqual({ baseUrl: 'https://x/v1', model: 'm', timeoutMs: 600_000, apiVersion: '2024-10-21', headers: { 'HTTP-Referer': 'https://ade' } })
    expect(sanitizeEndpointConfig({ baseUrl: 'file:///etc', timeoutMs: 1 })).toEqual({ timeoutMs: 1000 })
    expect(sanitizeEndpointConfig({ baseUrl: 'https://u:p@host' })).toBeUndefined()
    expect(sanitizeEndpointConfig('x')).toBeUndefined()
  })

  it('整理の設定: 実行方法は CLI か api:提供元、知らない提供元の接続先は捨てる', () => {
    expect(isOrganizeRunnerId('api:anthropic')).toBe(true)
    expect(isOrganizeRunnerId('api:unknown')).toBe(false)
    const s = sanitize({ organizer: { runner: 'api:openrouter', endpoints: { openrouter: { model: 'x/y' }, evil: { model: 'z' } } } })
    expect(s.organizer).toEqual({ runner: 'api:openrouter', endpoints: { openrouter: { model: 'x/y' } } })
    expect(sanitize({ organizer: { runner: 'rm -rf' } })).not.toHaveProperty('organizer')
  })
})

const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }
const req = { prompt: 'PROMPT', schema: SCHEMA, cwd: '/tmp', timeoutMs: 5000 }

describe('整理（API）: 要求の組み立て', () => {
  it('Anthropic: /v1/messages、x-api-key と anthropic-version、出力は output_config の json_schema で縛る', () => {
    const r = new ApiLlmRunner({ provider: 'anthropic', apiKey: 'sk-ant-xyz' }).buildRequest(req)
    expect(r.url).toBe('https://api.anthropic.com/v1/messages')
    expect(r.headers).toMatchObject({ 'x-api-key': 'sk-ant-xyz', 'anthropic-version': '2023-06-01' })
    const body = JSON.parse(r.body)
    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.max_tokens).toBe(16000)
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } })
    // 道具の強制（tool_choice）は使わない（Opus 5.5 などで 400 になる）
    expect(body.tool_choice).toBeUndefined()
    expect(body.messages).toEqual([{ role: 'user', content: 'PROMPT' }])
  })

  it('OpenAI: chat/completions の response_format で strict な json_schema', () => {
    const body = JSON.parse(new ApiLlmRunner({ provider: 'openai', apiKey: 'sk-test' }).buildRequest(req).body)
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'organize_output', strict: true, schema: SCHEMA } })
  })

  it('OpenRouter・互換: スキーマをプロンプト（system）に書き、response_format は送らない。/v1 の有無を問わない', () => {
    const r = new ApiLlmRunner({ provider: 'compatible', endpoint: { baseUrl: 'http://localhost:11434', model: 'llama3' } }).buildRequest(req)
    expect(r.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(r.headers.Authorization).toBeUndefined()
    const body = JSON.parse(r.body)
    expect(body.response_format).toBeUndefined()
    expect(body.messages[0]).toEqual({ role: 'system', content: schemaInstruction(SCHEMA) })
    const or = new ApiLlmRunner({ provider: 'openrouter', apiKey: 'sk-or-1', endpoint: { headers: { 'X-Title': 'ADE' } } }).buildRequest(req)
    expect(or.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(or.headers).toMatchObject({ Authorization: 'Bearer sk-or-1', 'X-Title': 'ADE' })
  })

  it('Gemini: generateContent、responseMimeType=application/json、キーはヘッダー', () => {
    const r = new ApiLlmRunner({ provider: 'gemini', apiKey: 'AIza-test', endpoint: { model: 'gemini-2.5-pro' } }).buildRequest(req)
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
    expect(r.headers['x-goog-api-key']).toBe('AIza-test')
    const body = JSON.parse(r.body)
    expect(body.generationConfig).toEqual({ responseMimeType: 'application/json' })
    expect(body.systemInstruction.parts[0].text).toContain('"required":["ok"]')
  })
})

describe('整理（API）: 応答の読み取りと実行', () => {
  it('提供元ごとの本文を取り出し、拒否・打ち切りは失敗にする', () => {
    const a = new ApiLlmRunner({ provider: 'anthropic', apiKey: 'k' })
    expect(a.parseResponse({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 3 } }))
      .toEqual({ text: '{"ok":true}', usage: { input_tokens: 3 } })
    expect(() => a.parseResponse({ content: [], stop_reason: 'refusal' })).toThrow(RunnerError)
    expect(() => a.parseResponse({ content: [], stop_reason: 'max_tokens' })).toThrow('途中で切れました')
    const o = new ApiLlmRunner({ provider: 'openai', apiKey: 'k' })
    expect(o.parseResponse({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }).text).toBe('{"ok":true}')
    expect(() => o.parseResponse({ choices: [{ message: { content: null, refusal: 'no' } }] })).toThrow('断りました')
    expect(() => o.parseResponse({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] })).toThrow('途中で切れました')
    const g = new ApiLlmRunner({ provider: 'gemini', apiKey: 'k' })
    expect(g.parseResponse({ candidates: [{ content: { parts: [{ text: '{"ok":' }, { text: 'true}' }] } }] }).text).toBe('{"ok":true}')
    expect(() => g.parseResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow('断りました')
  })

  it('コードの囲みの中の JSON を取り出し、validate.ts の検証まで通る', async () => {
    const good = { items: [{ title: 'ボタンの色が薄い', request: '申し込むボタンの色を濃くする', status: 'decided', quote_ts: [18_000], frame_times: [19_750], annotation_ids: ['p3'] }], dropped: [] }
    mockFetch(() => json({ choices: [{ message: { content: '```json\n' + JSON.stringify(good) + '\n```' } }] }))
    const runner = new ApiLlmRunner({ provider: 'openrouter', apiKey: 'sk-or-1' })
    const r = await refineWithLlm(material, buildDraftDocument(material), { runner, cwd: '/tmp' })
    expect(r.fellBack).toBe(false)
    expect(r.document.items[0]!.request).toBe('申し込むボタンの色を濃くする')
    // スキーマに合わない JSON は下書きへ戻る
    mockFetch(() => json({ choices: [{ message: { content: '{"items":"x"}' } }] }))
    expect((await refineWithLlm(material, buildDraftDocument(material), { runner, cwd: '/tmp' })).fellBack).toBe(true)
  })

  it('HTTP の失敗は理由を言い分け、キーは伏せる。キーが無ければ送らない', async () => {
    mockFetch(() => new Response('invalid x-api-key sk-ant-secret-value-123', { status: 401 }))
    const err = await new ApiLlmRunner({ provider: 'anthropic', apiKey: 'sk-ant-secret-value-123' }).run(req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunnerError)
    expect((err as RunnerError).message).toContain('APIキーを確認')
    expect(JSON.stringify(err)).not.toContain('sk-ant-secret-value-123')
    expect((err as RunnerError).stderrTail).not.toContain('sk-ant-secret-value-123')
    mockFetch(() => new Response('{"error":{"message":"model: claude-x not found"}}', { status: 404 }))
    expect((await new ApiLlmRunner({ provider: 'anthropic', apiKey: 'k' }).run(req).catch((e: Error) => e) as Error).message).toContain('モデル名を確認')
    const calls = mockFetch(() => json({}))
    const noKey = new ApiLlmRunner({ provider: 'openai' })
    expect(await noKey.available()).toBe(false)
    await expect(noKey.run(req)).rejects.toThrow('APIキーが設定されていません')
    expect(calls).toHaveLength(0)
  })

  it('接続の確認: 短い質問の JSON が返れば ok', async () => {
    mockFetch(() => json({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }))
    expect(await checkLlmRunner({ provider: 'anthropic', apiKey: 'k' })).toMatchObject({ ok: true })
    vi.stubGlobal('fetch', vi.fn(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e }))
    expect((await checkLlmRunner({ provider: 'gemini', apiKey: 'k' })).message).toContain('応答がありません')
  })
})

describe('キーは提供元（vendor）ごとに保存し、文字起こしと整理で共有する', () => {
  it('Anthropic・Google などのキーも暗号化して保存でき、配布版は環境変数を読まない', async () => {
    const { SttKeyStore, devKeyEnv } = await import('../../src/main/pipeline/stt/keys')
    const dir = await mkdtemp(join(tmpdir(), 'ade-vendor-keys-'))
    const cipher = { available: () => true, encrypt: (s: string) => Buffer.from([...Buffer.from(s)].reverse()), decrypt: (b: Buffer) => Buffer.from([...b].reverse()).toString() }
    try {
      const file = join(dir, 'k.bin')
      const store = new SttKeyStore(file, cipher, devKeyEnv(true, { OPENAI_API_KEY: 'sk-developer-0000000000000' }))
      await store.set('anthropic', 'sk-ant-user-key')
      await store.set('google', 'AIza-user-key')
      const next = new SttKeyStore(file, cipher, devKeyEnv(true, { OPENAI_API_KEY: 'sk-developer-0000000000000' }))
      await next.load()
      expect(next.get('anthropic')).toBe('sk-ant-user-key')
      expect(next.get('google')).toBe('AIza-user-key')
      expect(next.get('openai')).toBeUndefined()
      expect(next.source('deepgram')).toBeNull()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('提供元の表示名', () => {
  it('固有名詞はそのまま、OpenAI 互換だけ訳す（文字起こし・整理とも）', async () => {
    const { providerLabel } = await import('@shared/aiProviders')
    const { t } = await import('@shared/i18n')
    setLocale('ja')
    expect(providerLabel(STT_PROVIDER_PRESETS.compatible, t)).toBe('OpenAI互換')
    expect(providerLabel(LLM_PROVIDER_PRESETS.compatible, t)).toBe('OpenAI互換')
    expect(providerLabel(STT_PROVIDER_PRESETS.deepgram, t)).toBe('Deepgram')
    setLocale('en')
    expect(providerLabel(STT_PROVIDER_PRESETS.compatible, t)).toBe('OpenAI-compatible')
  })
})
