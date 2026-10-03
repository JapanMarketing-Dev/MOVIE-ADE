/**
 * 文字起こしの接続先（端末内 / OpenAI / OpenAI 互換）とキーの保管・費用上限のテスト。
 * 実際の OpenAI には送らない。接続の確認はローカルに立てたモックのサーバーで確かめる。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exceedsCostLimit, normalizeBaseUrl, sanitizeCostLimit } from '../../src/main/pipeline/stt/endpoint'
import { OpenAiSttEngine, checkSttConnection, describeHttpFailure, sttPricePerMinuteUsd } from '../../src/main/pipeline/stt/openai'
import { SttKeyStore, devKeyEnv, loadDevDotEnv, safeStorageCipher, validateSttKey, type KeyCipher } from '../../src/main/pipeline/stt/keys'

// settings.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')
const { sanitize } = await import('../../src/main/settings')

describe('Base URL の正規化', () => {
  it('末尾の / と /v1 の有無にかかわらず同じ形にする', () => {
    for (const raw of ['http://gpu-box:8000', 'http://gpu-box:8000/', 'http://gpu-box:8000/v1', 'http://gpu-box:8000/v1/', ' http://gpu-box:8000/v1// ']) {
      expect(normalizeBaseUrl(raw)).toBe('http://gpu-box:8000')
    }
  })

  it('途中のパスは残し、貼り付けた入口（/v1/audio/transcriptions）は落とす', () => {
    expect(normalizeBaseUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai')
    expect(normalizeBaseUrl('https://api.groq.com/openai/v1/audio/transcriptions')).toBe('https://api.groq.com/openai')
    expect(normalizeBaseUrl('https://api.openai.com')).toBe('https://api.openai.com')
  })

  it('http / https 以外、壊れた URL、空、URL に埋め込んだ認証情報は断る', () => {
    expect(normalizeBaseUrl('ftp://host/v1')).toBeNull()
    expect(normalizeBaseUrl('gpu-box:8000')).toBeNull()
    expect(normalizeBaseUrl('not a url')).toBeNull()
    expect(normalizeBaseUrl('')).toBeNull()
    expect(normalizeBaseUrl(undefined)).toBeNull()
    expect(normalizeBaseUrl('http://user:secret@gpu-box:8000/v1')).toBeNull()
  })
})

describe('設定の sanitize（文字起こしの接続先）', () => {
  const base = { captureMic: true, captureSystemAudio: false, language: 'auto', keepDays: 7, stayFeedbackOnStop: false }

  it('provider は local と提供元のプリセット（openai / groq / deepgram …）のどれか。知らない値は local', () => {
    expect(sanitize({ capture: { ...base, transcription: 'compatible' } }).capture?.transcription).toBe('compatible')
    expect(sanitize({ capture: { ...base, transcription: 'openai' } }).capture?.transcription).toBe('openai')
    expect(sanitize({ capture: { ...base, transcription: 'groq' } }).capture?.transcription).toBe('groq')
    expect(sanitize({ capture: { ...base, transcription: 'deepgram' } }).capture?.transcription).toBe('deepgram')
    expect(sanitize({ capture: { ...base, transcription: 'whisper-cloud' } }).capture?.transcription).toBe('local')
    expect(sanitize({ capture: { ...base, transcription: 'toString' } }).capture?.transcription).toBe('local')
  })

  it('以前の baseUrl / model は sttEndpoints.compatible へ移し、壊れた値・モデル名の空白は落とす', () => {
    const c = sanitize({ capture: { ...base, transcription: 'compatible', baseUrl: 'http://localhost:8000/v1/', model: '  whisper-large-v3 ' } }).capture
    expect(c?.sttEndpoints?.compatible).toEqual({ baseUrl: 'http://localhost:8000', model: 'whisper-large-v3' })
    expect(c).not.toHaveProperty('baseUrl')
    expect(c).not.toHaveProperty('model')
    const broken = sanitize({ capture: { ...base, transcription: 'compatible', baseUrl: 'javascript:alert(1)', model: '   ' } }).capture
    expect(broken).not.toHaveProperty('sttEndpoints')
    // 新しい形が既にあれば、古い値で上書きしない
    const both = sanitize({ capture: { ...base, baseUrl: 'http://old:1', sttEndpoints: { compatible: { baseUrl: 'http://new:2/v1' } } } }).capture
    expect(both?.sttEndpoints?.compatible).toEqual({ baseUrl: 'http://new:2/v1' })
  })

  it('費用上限は null（なし）を保ち、壊れた値は既定（未設定＝$1）に戻す', () => {
    expect(sanitize({ capture: { ...base, costLimitUsd: null } }).capture?.costLimitUsd).toBeNull()
    expect(sanitize({ capture: { ...base, costLimitUsd: 5 } }).capture?.costLimitUsd).toBe(5)
    expect(sanitize({ capture: { ...base, costLimitUsd: -1 } }).capture).not.toHaveProperty('costLimitUsd')
    expect(sanitize({ capture: { ...base, costLimitUsd: 'x' } }).capture).not.toHaveProperty('costLimitUsd')
    expect(sanitizeCostLimit(0)).toBeUndefined()
    expect(sanitizeCostLimit(0.123)).toBe(0.12)
    expect(sanitizeCostLimit(1e9)).toBe(1000)
  })

  it('キー本体は settings.json に入らない（capture に apiKey を混ぜても捨てる）', () => {
    const c = sanitize({ capture: { ...base, apiKey: 'sk-should-not-be-saved-1234567890' } }).capture
    expect(JSON.stringify(c)).not.toContain('sk-should-not')
  })
})

describe('費用の上限', () => {
  it('上限を超えるかの判定。null は上限なし、省略は $1', () => {
    expect(exceedsCostLimit(0.9, 0.2, 1)).toBe(true)
    expect(exceedsCostLimit(0.5, 0.5, 1)).toBe(false)
    expect(exceedsCostLimit(999, 999, null)).toBe(false)
    expect(exceedsCostLimit(0.9, 0.2, undefined)).toBe(true)
  })

  it('表にないモデル（互換サーバー）は多めの単価で概算する', () => {
    expect(sttPricePerMinuteUsd('gpt-transcribe')).toBe(0.0045)
    expect(sttPricePerMinuteUsd('Systran/faster-whisper-small')).toBe(0.006)
  })

  describe('エンジンでの扱い', () => {
    let dir = ''
    afterEach(async () => { vi.unstubAllGlobals(); if (dir) await rm(dir, { recursive: true, force: true }) })

    it('上限なしなら長い音声でも送る。上限ありなら送らずに止める', async () => {
      dir = await mkdtemp(join(tmpdir(), 'ade-stt-limit-'))
      const wavPath = join(dir, 'c.wav')
      await writeFile(wavPath, Buffer.from('fixture'))
      const fake = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'こんにちは' }), { status: 200 }))
      vi.stubGlobal('fetch', fake)
      const input = { wavPath, offsetMs: 0, speaker: 'self' as const, source: 'mic' as const, durationMs: 10 * 60 * 60_000 }
      const unlimited = new OpenAiSttEngine({ model: 'my-model', baseUrl: 'http://gpu:8000/v1', keyOptional: true, maxCostUsd: null, label: '接続先' })
      expect((await unlimited.transcribeChunk(input)).segments[0]?.text).toBe('こんにちは')
      const limited = new OpenAiSttEngine({ model: 'my-model', baseUrl: 'http://gpu:8000/v1', keyOptional: true, maxCostUsd: 1, label: '接続先' })
      await expect(limited.transcribeChunk(input)).rejects.toThrow('接続先の文字起こしの費用上限')
      expect(fake).toHaveBeenCalledTimes(1)
    })

    it('互換サーバー: キーが無ければ Authorization を付けず、正規化した入口へ送る', async () => {
      dir = await mkdtemp(join(tmpdir(), 'ade-stt-compat-'))
      const wavPath = join(dir, 'c.wav')
      await writeFile(wavPath, Buffer.from('fixture'))
      const fake = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'ok' }), { status: 200 }))
      vi.stubGlobal('fetch', fake)
      const e = new OpenAiSttEngine({ model: 'whisper-large-v3', baseUrl: 'http://gpu:8000/v1/', keyOptional: true, language: 'ja' })
      await e.transcribeChunk({ wavPath, offsetMs: 0, speaker: 'self', source: 'mic', durationMs: 1000 })
      const [url, init] = fake.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('http://gpu:8000/v1/audio/transcriptions')
      expect(init.headers).toEqual({})
      const form = init.body as FormData
      // 表にないモデルは json と language だけ（OpenAI 固有の languages[] / keywords[] は送らない）
      expect(form.getAll('response_format').map(String)).toEqual(['json'])
      expect(form.getAll('language').map(String)).toEqual(['ja'])
      expect(form.getAll('languages[]')).toEqual([])
    })

    it('OpenAI はキーを渡さなければ作れない。環境変数のキーへ黙って切り替えない', () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-developer-key-0000000000')
      try {
        expect(() => new OpenAiSttEngine({ model: 'gpt-transcribe' })).toThrow('端末内の文字起こし')
      } finally { vi.unstubAllEnvs() }
    })

    it('失敗の本文にキーがそのまま返ってきても伏せる', async () => {
      dir = await mkdtemp(join(tmpdir(), 'ade-stt-redact-'))
      const wavPath = join(dir, 'c.wav')
      await writeFile(wavPath, Buffer.from('fixture'))
      const key = 'gsk_abcdefghijklmnop123456'
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`invalid key ${key}`, { status: 401 })))
      const e = new OpenAiSttEngine({ model: 'whisper-large-v3', baseUrl: 'https://api.groq.com/openai/v1', apiKey: key, keyOptional: true })
      const err = await e.transcribeChunk({ wavPath, offsetMs: 0, speaker: 'self', source: 'mic', durationMs: 1000 }).catch((x: Error) => x)
      expect(String(err)).toContain('401')
      expect(String(err)).not.toContain(key)
    })
  })
})

/** テスト用の暗号化。可否を切り替えられる（中身は反転するだけ） */
function fakeCipher(available: boolean): KeyCipher & { calls: number } {
  const c = {
    calls: 0,
    available: () => available,
    encrypt: (t: string) => { c.calls++; return Buffer.from(t, 'utf8').map((b) => 255 - b) as Buffer },
    decrypt: (d: Buffer) => Buffer.from(d.map((b) => 255 - b)).toString('utf8'),
  }
  return c
}

describe('キーの保管', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
  const openaiKey = 'sk-test-abcdefghijklmnopqrstuvwxyz'

  it('暗号化できる環境では暗号化して保存し、次の起動で読める', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-keys-'))
    const file = join(dir, 'stt-keys.bin')
    const store = new SttKeyStore(file, fakeCipher(true), {})
    expect(store.storage()).toBe('encrypted')
    expect(await store.set('openai', openaiKey)).toEqual({ persisted: true })
    expect(await store.set('compatible', 'gsk_groqkey123')).toEqual({ persisted: true })
    // 平文で書かれていない
    expect((await readFile(file)).toString('utf8')).not.toContain(openaiKey)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)

    const next = new SttKeyStore(file, fakeCipher(true), {})
    await next.load()
    expect(next.get('openai')).toBe(openaiKey)
    expect(next.get('compatible')).toBe('gsk_groqkey123')
    expect(next.source('openai')).toBe('saved')
  })

  it('解除するとファイルから消え、全部消えたらファイルも消す', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-keys-'))
    const file = join(dir, 'stt-keys.bin')
    const store = new SttKeyStore(file, fakeCipher(true), {})
    await store.set('openai', openaiKey)
    await store.set('compatible', 'token-1')
    await store.set('openai', '')
    const next = new SttKeyStore(file, fakeCipher(true), {})
    await next.load()
    expect(next.get('openai')).toBeUndefined()
    expect(next.get('compatible')).toBe('token-1')
    await store.set('compatible', '')
    await expect(stat(file)).rejects.toThrow()
  })

  it('暗号化できない環境（Linux で鍵束が無い等）では保存せず、起動中だけ持つ', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-keys-'))
    const file = join(dir, 'stt-keys.bin')
    const cipher = fakeCipher(false)
    const store = new SttKeyStore(file, cipher, {})
    expect(store.storage()).toBe('session')
    expect(await store.set('openai', openaiKey)).toEqual({ persisted: false })
    expect(store.get('openai')).toBe(openaiKey)
    expect(store.source('openai')).toBe('session')
    expect(cipher.calls).toBe(0)
    await expect(stat(file)).rejects.toThrow()
  })

  it('.env の OPENAI_API_KEY は保存したキーが無いときだけ使う（互換サーバーには使わない）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-keys-'))
    const store = new SttKeyStore(join(dir, 'k.bin'), fakeCipher(true), { OPENAI_API_KEY: 'sk-from-dotenv-0000000000' })
    await store.load()
    expect(store.get('openai')).toBe('sk-from-dotenv-0000000000')
    expect(store.source('openai')).toBe('env')
    expect(store.get('compatible')).toBeUndefined()
    await store.set('openai', openaiKey)
    expect(store.get('openai')).toBe(openaiKey)
  })

  it('配布版（isPackaged）は環境変数・.env のキーを一切読まない', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-keys-'))
    const env = { OPENAI_API_KEY: 'sk-developer-key-0000000000' }
    expect(devKeyEnv(true, env)).toEqual({})
    expect(devKeyEnv(false, env)).toBe(env)
    const packaged = new SttKeyStore(join(dir, 'k.bin'), fakeCipher(true), devKeyEnv(true, env))
    await packaged.load()
    expect(packaged.get('openai')).toBeUndefined()
    expect(packaged.source('openai')).toBeNull()
    // 既定（env を渡さない）も読まない
    vi.stubEnv('OPENAI_API_KEY', 'sk-developer-key-0000000000')
    try {
      expect(new SttKeyStore(join(dir, 'k2.bin'), fakeCipher(true)).get('openai')).toBeUndefined()
    } finally { vi.unstubAllEnvs() }

    const dotenv = join(dir, '.env')
    await writeFile(dotenv, 'OPENAI_API_KEY=sk-developer-key-0000000000\n')
    const load = vi.fn()
    expect(loadDevDotEnv(true, dotenv, load)).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(loadDevDotEnv(false, dotenv, load)).toBe(true)
    expect(load).toHaveBeenCalledWith(dotenv)
    expect(loadDevDotEnv(false, join(dir, 'missing.env'), load)).toBe(false)
  })

  it('復号できないファイルは無視する（キーをログに出さない）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-keys-'))
    const file = join(dir, 'k.bin')
    await writeFile(file, Buffer.from('garbage'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new SttKeyStore(file, { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: () => { throw new Error('bad') } }, {})
    await store.load()
    expect(store.get('compatible')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('形式を確かめ、エラーにキーを含めない', async () => {
    expect(validateSttKey('openai', openaiKey)).toBeNull()
    expect(validateSttKey('openai', 'gsk_abc')).toContain('sk-')
    expect(validateSttKey('compatible', 'gsk_abc')).toBeNull()
    expect(validateSttKey('compatible', 'has space')).not.toBeNull()
    dir = await mkdtemp(join(tmpdir(), 'ade-keys-'))
    const store = new SttKeyStore(join(dir, 'k.bin'), fakeCipher(true), {})
    await expect(store.set('openai', 'not-a-key-secret')).rejects.toThrow(/sk-/)
    await expect(store.set('openai', 'not-a-key-secret')).rejects.not.toThrow(/not-a-key-secret/)
  })

  it('safeStorage: Linux の basic_text（固定の鍵）は暗号化できないとみなす', () => {
    const ss = (backend: string, ok = true) => ({ isEncryptionAvailable: () => ok, encryptString: (t: string) => Buffer.from(t), decryptString: (b: Buffer) => b.toString(), getSelectedStorageBackend: () => backend })
    expect(safeStorageCipher(ss('basic_text'), 'linux').available()).toBe(false)
    expect(safeStorageCipher(ss('unknown'), 'linux').available()).toBe(false)
    expect(safeStorageCipher(ss('gnome_libsecret'), 'linux').available()).toBe(true)
    expect(safeStorageCipher(ss('kwallet5'), 'linux').available()).toBe(true)
    expect(safeStorageCipher(ss('unknown'), 'darwin').available()).toBe(true)
    expect(safeStorageCipher(ss('unknown'), 'win32').available()).toBe(true)
    expect(safeStorageCipher(ss('gnome_libsecret', false), 'linux').available()).toBe(false)
  })
})

describe('接続の確認（ローカルのモックのサーバー）', () => {
  let server: ReturnType<typeof createServer> | null = null
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null })

  /** OpenAI 互換の文字起こしを真似る。キー test-token と モデル good だけを受け付ける */
  async function startMock(): Promise<{ url: string; seen: Array<{ path: string; auth?: string; bytes: number }> }> {
    const seen: Array<{ path: string; auth?: string; bytes: number }> = []
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1')
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, bytes: body.length })
        if (req.url !== '/v1/audio/transcriptions') { res.writeHead(404).end('Not Found'); return }
        if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401).end('{"error":"invalid api key"}'); return }
        if (!/name="model"\r\n\r\ngood\r\n/.test(body)) { res.writeHead(404).end('{"error":{"message":"The model `bad` does not exist"}}'); return }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"text":""}')
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen }
  }

  it('届けば ok。1秒の無音 WAV を送る', async () => {
    const { url, seen } = await startMock()
    const r = await checkSttConnection({ baseUrl: `${url}/v1/`, model: 'good', apiKey: 'test-token', label: '接続先' })
    expect(r).toEqual({ ok: true, message: '接続先へ届きました（モデル good）。' })
    // 16kHz モノラル 16bit の1秒 = 32000バイト＋ヘッダ
    expect(seen[0]?.bytes).toBeGreaterThan(32_000)
  })

  it('認証エラー・モデル名の誤り・URL の誤りを言い分ける', async () => {
    const { url } = await startMock()
    expect((await checkSttConnection({ baseUrl: url, model: 'good', apiKey: 'wrong' })).message).toContain('APIキーを確認')
    expect((await checkSttConnection({ baseUrl: url, model: 'good' })).message).toContain('認証を拒否')
    expect((await checkSttConnection({ baseUrl: url, model: 'bad', apiKey: 'test-token' })).message).toContain('モデル名を確認')
    expect((await checkSttConnection({ baseUrl: `${url}/wrong/v1`, model: 'good', apiKey: 'test-token' })).message).toContain('Base URL を確認')
  })

  it('つながらない・URL が壊れている・モデル名が空', async () => {
    const { url } = await startMock()
    const closed = url
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    expect((await checkSttConnection({ baseUrl: closed, model: 'good' })).message).toContain('接続できません')
    expect((await checkSttConnection({ baseUrl: 'gpu-box:8000', model: 'good' })).message).toContain('Base URL が正しくありません')
    expect((await checkSttConnection({ baseUrl: 'http://localhost:1', model: ' ' })).message).toContain('モデル名を入れて')
  })

  it('状態コードの言い分け（その他）', () => {
    expect(describeHttpFailure(429, '', 'OpenAI')).toContain('残高')
    expect(describeHttpFailure(500, '', '接続先')).toContain('サーバーのログ')
    expect(describeHttpFailure(400, 'audio too short', '接続先')).toContain('(400)')
  })
})

describe('接続の確認の文（英語の画面）', () => {
  it('送り先の名前で始まる文は先頭を大文字にする', () => {
    setLocale('en')
    try {
      expect(describeHttpFailure(401, '', 'the endpoint')).toBe('The endpoint rejected authentication (401). Check your API key.')
      expect(describeHttpFailure(429, '', 'OpenAI')).toContain('OpenAI usage limit')
    } finally {
      setLocale('ja')
    }
  })
})
