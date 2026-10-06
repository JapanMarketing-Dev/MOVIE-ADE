/**
 * 外部の応答の大きさの上限（レポート [8]）。本物のネットワークは呼ばず、127.0.0.1 の偽の接続先から
 * 「宣言の長さが大きすぎる応答」と「長さの無い終わらない応答（chunked）」を返して、上限で止まるかを確かめる
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import { isUserFacingError } from '@shared/errors'
import {
  AI_RESPONSE_MAX_BYTES,
  ResponseTooLargeError,
  readBoundedBytes,
  readBoundedJson,
  readErrorText
} from '../../src/main/boundedResponse'
import { OpenAiSttEngine } from '../../src/main/pipeline/stt/openai'
import { CloudSttEngine } from '../../src/main/pipeline/stt/cloud'
import { writeWavFile } from '../../src/main/pipeline/stt/wav'
import { ApiLlmRunner } from '../../src/main/pipeline/organize/runners/api'
import { RunnerError } from '../../src/main/pipeline/organize/runner'
import { DecisionRelay } from '../../src/main/decision/relay'

/** 中継が受け付ける最小の System One の依頼（security-7 [7]。形の違う本文は送らずに断る） */
const SYSTEM_ONE_BODY = JSON.stringify({ model: 'm', state: 's', questions: { ok: { type: 'noul' } } })

setLocale('en')

type Mode = 'declared-huge' | 'chunked-endless' | 'error-endless' | 'ok-json' | 'not-json'

let server: Server
let base = ''
let mode: Mode = 'ok-json'
/** 偽の接続先が書き出したバイト数（止めた時点でどこまで送らせたか） */
let sent = 0
/** 接続が相手から切られたか */
let closedByClient = false

const CHUNK = Buffer.alloc(64 * 1024, 0x61)

function endless(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  const pump = () => {
    while (!res.destroyed && res.write(CHUNK)) {
      sent += CHUNK.length
      // テストが固まらないよう、切られなくても 512MB で止める
      if (sent > 512 * 1024 * 1024) return res.end()
    }
    if (!res.destroyed) res.once('drain', () => { sent += CHUNK.length; pump() })
  }
  pump()
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    res.on('close', () => { if (!res.writableEnded) closedByClient = true })
    if (mode === 'declared-huge') {
      // 100GB と宣言して、少しだけ送って止まる
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(100 * 1024 * 1024 * 1024) })
      res.write('{"text":"')
      return
    }
    if (mode === 'chunked-endless') return endless(res, 200)
    if (mode === 'error-endless') return endless(res, 500)
    if (mode === 'not-json') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!DOCTYPE html><html>secret-proxy-page</html>')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: 'ok', choices: [{ message: { content: '{"issues":[]}' } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  sent = 0
  closedByClient = false
})

const get = (m: Mode) => { mode = m; return fetch(`${base}/x`) }

describe('security-2 [12] 上限つきの読み手', () => {
  it('宣言の長さが上限を超えていれば、読む前に断る', async () => {
    const res = await get('declared-huge')
    await expect(readBoundedBytes(res, 1024)).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('長さの無い終わらない応答も、上限を超えた時点で読むのをやめて接続を切る', async () => {
    const res = await get('chunked-endless')
    const limit = 256 * 1024
    await expect(readBoundedBytes(res, limit)).rejects.toBeInstanceOf(ResponseTooLargeError)
    // 送らせた量は上限＋ソケットのバッファ程度に収まる（最後まで読んでいない）
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toBeLessThan(64 * 1024 * 1024)
    expect(closedByClient).toBe(true)
  })

  it('上限を超えた応答のエラーは、利用者向けのもの（Sentry に送らない）', async () => {
    const res = await get('declared-huge')
    const err = await readBoundedJson(res, 1024).catch((e: unknown) => e)
    expect(isUserFacingError(err)).toBe(true)
    expect((err as Error).message).toMatch(/too large/)
  })

  it('失敗の本文は上限で打ち切って返す（投げない）', async () => {
    const res = await get('error-endless')
    const text = await readErrorText(res, 1000)
    expect(text.length).toBe(1000)
  })

  it('上限以内ならそのまま読める', async () => {
    const res = await get('ok-json')
    expect(await readBoundedJson(res)).toMatchObject({ text: 'ok' })
  })
})

describe('security-2 [12] 各クライアントが上限で止まる', () => {
  let dir = ''
  let wavPath = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ade-bounded-'))
    wavPath = join(dir, 'c.wav')
    await writeWavFile(wavPath, new Int16Array(1600), 16_000)
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })
  const input = () => ({ wavPath, offsetMs: 0, speaker: 'self' as const, source: 'mic' as const, durationMs: 1000 })

  for (const m of ['declared-huge', 'chunked-endless'] as const) {
    it(`文字起こし（OpenAI 互換）: ${m}`, async () => {
      mode = m
      const engine = new OpenAiSttEngine({ model: 'whisper-1', apiKey: 'k', baseUrl: base, maxCostUsd: null })
      await expect(engine.transcribeChunk(input())).rejects.toBeInstanceOf(ResponseTooLargeError)
      expect(sent).toBeLessThan(AI_RESPONSE_MAX_BYTES + 64 * 1024 * 1024)
    })

    it(`文字起こし（クラウド）: ${m}`, async () => {
      mode = m
      const engine = new CloudSttEngine({ kind: 'deepgram', label: 'X', baseUrl: base, model: 'm', apiKey: 'k', maxCostUsd: null })
      await expect(engine.transcribeChunk(input())).rejects.toBeInstanceOf(ResponseTooLargeError)
    })

    it(`整理（API）: ${m}`, async () => {
      mode = m
      const runner = new ApiLlmRunner({ provider: 'compatible', endpoint: { baseUrl: base, model: 'm' } })
      const err = await runner.run({ prompt: 'p', schema: {}, cwd: dir, timeoutMs: 10_000 }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RunnerError)
      expect((err as Error).message).toMatch(/too large/)
    })

    it(`判定の中継: ${m}`, async () => {
      mode = m
      const relay = new DecisionRelay({ upstream: async () => ({ url: `${base}/up`, headers: {}, provider: 'p', model: 'm', timeoutMs: 10_000 }), maxResponseBytes: 1024 * 1024 })
      await relay.start()
      try {
        const res = await fetch(relay.urlFor(relay.issue()), { method: 'POST', body: SYSTEM_ONE_BODY })
        expect(res.status).toBe(502)
        expect(await res.json()).toMatchObject({ error_type: 'relay_upstream_too_large' })
      } finally {
        await relay.stop()
      }
    })
  }

  it('失敗の応答（500・終わらない本文）も、上限で読むのをやめて失敗として返す（文字起こし・クラウド・整理）', async () => {
    mode = 'error-endless'
    const openai = new OpenAiSttEngine({ model: 'whisper-1', apiKey: 'k', baseUrl: base, maxCostUsd: null })
    await expect(openai.transcribeChunk(input())).rejects.toMatchObject({ status: 500 })
    const cloud = new CloudSttEngine({ kind: 'deepgram', label: 'X', baseUrl: base, model: 'm', apiKey: 'k', maxCostUsd: null })
    await expect(cloud.transcribeChunk(input())).rejects.toMatchObject({ status: 500 })
    const runner = new ApiLlmRunner({ provider: 'compatible', endpoint: { baseUrl: base, model: 'm' } })
    await expect(runner.run({ prompt: 'p', schema: {}, cwd: dir, timeoutMs: 10_000 })).rejects.toBeInstanceOf(RunnerError)
    await new Promise((r) => setTimeout(r, 50))
    // 3回分を合わせても、上限（64KB）＋ソケットのバッファ程度しか送らせていない
    expect(sent).toBeLessThan(3 * 64 * 1024 * 1024)
  })

  it('整理（API）: JSON でない応答は本文の断片を含む SyntaxError にせず、RunnerError にする', async () => {
    mode = 'not-json'
    const runner = new ApiLlmRunner({ provider: 'compatible', endpoint: { baseUrl: base, model: 'm' } })
    const err = await runner.run({ prompt: 'p', schema: {}, cwd: dir, timeoutMs: 10_000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunnerError)
    expect((err as Error).message).not.toContain('secret-proxy-page')
  })
})
