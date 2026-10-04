import { describe, expect, it, vi } from 'vitest'
import { FEEDBACK_RELAY_URL, MAX_BODY_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES } from '@shared/feedbackRelay'
import { buildRelayForm, checkSubmission, sendToRelay, shouldFallBackToBrowser, sniffImageType, type RelaySubmission } from '../../src/main/feedbackRelay'
import { fitScreenshot, type ImageLike } from '../../src/main/feedbackCapture'
import { FEEDBACK_ASK_AFTER_SENDS, DEFAULT_STAR_PROMPT, shouldAskFeedback } from '@shared/starPrompt'

/**
 * 匿名フィードバックの中継へ送るアプリの側（src/main/feedbackRelay.ts）。偽の fetch だけを使い、本物の中継へは送らない。
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const INSTALL = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

const sub = (patch: Partial<RelaySubmission> = {}): RelaySubmission => ({
  kind: 'bug', title: '録画が止まらない', body: '### What did you do?\n\nx', appVersion: '0.2.0',
  platform: 'darwin', arch: 'arm64', osRelease: '25.6.0', installId: INSTALL, images: [], ...patch
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

describe('中継: 送る前の確認（中継と同じ上限）', () => {
  it('PNG / JPEG を中身の先頭で見分ける', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBeNull()
  })

  it('題名・本文・メタ・画像の上限', () => {
    expect(checkSubmission(sub())).toBeNull()
    expect(checkSubmission(sub({ title: ' ' }))).toBe('invalid_title')
    expect(checkSubmission(sub({ title: 'a\nb' }))).toBe('invalid_title')
    expect(checkSubmission(sub({ title: 'あ'.repeat(201) }))).toBe('invalid_title')
    expect(checkSubmission(sub({ body: 'あ'.repeat(Math.ceil(MAX_BODY_BYTES / 3) + 1) }))).toBe('invalid_body')
    expect(checkSubmission(sub({ appVersion: '0.2.0 beta' }))).toBe('invalid_meta')
    expect(checkSubmission(sub({ platform: 'freebsd' }))).toBe('invalid_meta')
    expect(checkSubmission(sub({ installId: 'not-a-uuid' }))).toBe('invalid_meta')
    expect(checkSubmission(sub({ platform: undefined, arch: undefined, osRelease: undefined, installId: undefined }))).toBeNull()
    expect(checkSubmission(sub({ images: Array.from({ length: MAX_IMAGES + 1 }, () => ({ type: 'image/png' as const, data: PNG })) }))).toBe('too_many_images')
    expect(checkSubmission(sub({ images: [{ type: 'image/jpeg', data: PNG }] }))).toBe('bad_image')
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1); big.set(PNG)
    expect(checkSubmission(sub({ images: [{ type: 'image/png', data: big }] }))).toBe('image_too_large')
  })

  it('multipart は決まった名前だけ。外した項目は入れない', () => {
    const form = buildRelayForm(sub({ platform: undefined, arch: undefined, osRelease: undefined, installId: undefined, images: [{ type: 'image/png', data: PNG }] }))
    const names: string[] = []
    form.forEach((_value, name) => { names.push(name) })
    expect([...new Set(names)].sort()).toEqual(['appVersion', 'body', 'image', 'kind', 'title'])
    expect((form.get('image') as File).type).toBe('image/png')
  })
})

describe('中継: 送信と応答（偽の fetch）', () => {
  it('201 で Issue の URL を返す。POST・multipart・User-Agent', async () => {
    const fetch = vi.fn(async () => json(201, { ok: true, issue: 123, url: 'https://github.com/JapanMarketing-Dev/ferret/issues/123' }))
    expect(await sendToRelay(sub(), { fetch, userAgent: 'Ferret/0.2.0' })).toEqual({ ok: true, issue: 123, url: 'https://github.com/JapanMarketing-Dev/ferret/issues/123' })
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(FEEDBACK_RELAY_URL)
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('Ferret/0.2.0')
  })

  it('GitHub 以外の URL が返ってきても信じない', async () => {
    const fetch = vi.fn(async () => json(201, { ok: true, issue: 1, url: 'https://evil.example.com/x' }))
    expect(await sendToRelay(sub(), { fetch, userAgent: 'u' })).toMatchObject({ ok: false, code: 'bad_response' })
  })

  it('code を分ける。429 は Retry-After、送り直せるのは 429・502・500 と通信の失敗だけ', async () => {
    const r429 = await sendToRelay(sub(), { fetch: async () => json(429, { ok: false, code: 'rate_limited' }, { 'Retry-After': '600' }), userAgent: 'u' })
    expect(r429).toEqual({ ok: false, code: 'rate_limited', retryable: true, retryAfterSec: 600 })
    expect(await sendToRelay(sub(), { fetch: async () => json(409, { ok: false, code: 'duplicate' }), userAgent: 'u' })).toEqual({ ok: false, code: 'duplicate', retryable: false })
    expect(await sendToRelay(sub(), { fetch: async () => json(502, { ok: false, code: 'upstream_failed' }), userAgent: 'u' })).toMatchObject({ code: 'upstream_failed', retryable: true })
    expect(await sendToRelay(sub(), { fetch: async () => new Response('<html>bad gateway</html>', { status: 503 }), userAgent: 'u' })).toMatchObject({ code: 'internal', retryable: true })
    expect(await sendToRelay(sub(), { fetch: async () => { throw new TypeError('net::ERR_NAME_NOT_RESOLVED') }, userAgent: 'u' })).toMatchObject({ code: 'network', retryable: true })
  })

  it('時間の上限で打ち切る', async () => {
    const fetch = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    expect(await sendToRelay(sub(), { fetch, userAgent: 'u', timeoutMs: 20 })).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('送る前に断られると分かっているものは送らない', async () => {
    const fetch = vi.fn()
    expect(await sendToRelay(sub({ title: '' }), { fetch, userAgent: 'u' })).toMatchObject({ ok: false, code: 'invalid_title', retryable: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ブラウザへ切り替えるのは中継が使えないときだけ（頻度・重複・大きさは切り替えない）', () => {
    for (const code of ['network', 'timeout', 'internal', 'upstream_failed', 'disabled', 'bad_response'] as const) expect(shouldFallBackToBrowser(code)).toBe(true)
    for (const code of ['rate_limited', 'duplicate', 'too_large', 'image_too_large', 'invalid_title'] as const) expect(shouldFallBackToBrowser(code)).toBe(false)
  })

  it('security-4 [12] 中継が「GitHub が作ったか分からない」と返したら、送り直さず・ブラウザにも回さない', async () => {
    expect(shouldFallBackToBrowser('upstream_pending')).toBe(false)
    expect(await sendToRelay(sub(), { fetch: async () => json(504, { ok: false, code: 'upstream_pending' }), userAgent: 'u' })).toEqual({ ok: false, code: 'upstream_pending', retryable: false })
  })
})

describe('画面の添付: 2MB に収める', () => {
  function fakeImage(width: number, bytesPerPixel: number, jpegRatio = 0.2): ImageLike {
    const height = Math.round(width * 0.6)
    return {
      getSize: () => ({ width, height }),
      toPNG: () => Buffer.alloc(Math.round(width * height * bytesPerPixel)),
      toJPEG: () => Buffer.alloc(Math.round(width * height * bytesPerPixel * jpegRatio)),
      resize: ({ width: w }) => fakeImage(w, bytesPerPixel, jpegRatio)
    }
  }

  it('小さければ PNG のまま', () => {
    expect(fitScreenshot(fakeImage(1000, 1))).toMatchObject({ type: 'image/png', width: 1000 })
  })

  it('大きければ縮め、それでも大きければ JPEG にする', () => {
    const shrunk = fitScreenshot(fakeImage(2880, 0.5))
    expect(shrunk.type).toBe('image/png')
    expect(shrunk.width).toBeLessThan(2880)
    expect(Buffer.from(shrunk.base64, 'base64').length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    expect(fitScreenshot(fakeImage(2880, 8)).type).toBe('image/jpeg')
  })
})

describe('使ったあとの一言（フィードバックの声かけ）', () => {
  const ok = { recording: false, onboardingDone: true }
  it('送信が 3 回に達したら一度だけ。録画中・セットアップ中は出さない', () => {
    expect(shouldAskFeedback({ ...DEFAULT_STAR_PROMPT, sends: FEEDBACK_ASK_AFTER_SENDS - 1 }, ok)).toBe(false)
    expect(shouldAskFeedback({ ...DEFAULT_STAR_PROMPT, sends: FEEDBACK_ASK_AFTER_SENDS }, ok)).toBe(true)
    expect(shouldAskFeedback({ ...DEFAULT_STAR_PROMPT, sends: 5, feedbackAsked: true }, ok)).toBe(false)
    expect(shouldAskFeedback({ ...DEFAULT_STAR_PROMPT, sends: 3 }, { recording: true, onboardingDone: true })).toBe(false)
    expect(shouldAskFeedback({ ...DEFAULT_STAR_PROMPT, sends: 3 }, { recording: false, onboardingDone: false })).toBe(false)
  })
})
