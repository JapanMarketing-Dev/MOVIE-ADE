/** モデルのダウンロード。ネットワークは呼ばず、fetch を差し替えて確かめる */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ModelDownloadError,
  discardPartialDownload,
  isAllowedModelUrl,
  downloadWhisperModel,
  partialDownloadSize
} from '../../src/main/pipeline/stt/download'
import type { DownloadProgress } from '../../src/main/pipeline/stt/download'

let dir: string
let dest: string

/** テストの小さな本文の sha256（本物のモデルの値の代わりに照合させる） */
const sha = (body: string) => createHash('sha256').update(body).digest('hex')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ade-dl-'))
  dest = join(dir, 'ggml-small.bin')
})

/** 固定の本文を返す fetch。Range の指定を記録する */
function fakeFetch(body: string, options: { honorRange?: boolean; status?: number } = {}) {
  const calls: Array<string | undefined> = []
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range') ?? undefined
    calls.push(range)
    if (options.status && options.status >= 400) {
      return new Response('error', { status: options.status })
    }
    const m = range ? /^bytes=(\d+)-/.exec(range) : null
    if (m && options.honorRange !== false) {
      const from = Number(m[1])
      const rest = body.slice(from)
      return new Response(rest, {
        status: 206,
        headers: { 'content-length': String(Buffer.byteLength(rest)) }
      })
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(body)) }
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('モデルのダウンロード', () => {
  it('落として所定の名前へ置く', async () => {
    const { impl } = fakeFetch('MODEL-BYTES')
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('MODEL-BYTES'), expectedBytes: 11 })
    expect(await readFile(dest, 'utf8')).toBe('MODEL-BYTES')
    // 途中ファイルは残らない
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('進捗を通知する', async () => {
    const { impl } = fakeFetch('0123456789')
    const seen: DownloadProgress[] = []
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10, onProgress: (p) => seen.push(p) })

    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen[0]!.modelId).toBe('small')
    const last = seen[seen.length - 1]!
    expect(last.receivedBytes).toBe(10)
    expect(last.totalBytes).toBe(10)
    expect(last.ratio).toBe(1)
  })

  it('途中まで落ちていれば Range で続きから取る', async () => {
    await writeFile(`${dest}.part`, '01234', 'utf8')
    const { impl, calls } = fakeFetch('0123456789')

    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })
    expect(calls[0]).toBe('bytes=5-')
    expect(await readFile(dest, 'utf8')).toBe('0123456789')
  })

  it('サーバーが Range を無視したら最初から取り直す', async () => {
    await writeFile(`${dest}.part`, '01234', 'utf8')
    const { impl } = fakeFetch('0123456789', { honorRange: false })

    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })
    // 二重に書き足されず、正しい内容になる
    expect(await readFile(dest, 'utf8')).toBe('0123456789')
  })

  it('既に完成していれば何もしない（通信もしない）', async () => {
    await writeFile(dest, 'ALREADY', 'utf8')
    const { impl, calls } = fakeFetch('NEW')
    await downloadWhisperModel('small', dest, { fetchImpl: impl })
    expect(calls).toHaveLength(0)
    expect(await readFile(dest, 'utf8')).toBe('ALREADY')
  })

  it('HTTPエラーは理由を添えて投げ、再開可能かを示す', async () => {
    const { impl } = fakeFetch('', { status: 503 })
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl })).rejects.toBeInstanceOf(
      ModelDownloadError
    )
    expect(existsSync(dest)).toBe(false)
  })

  it('通信エラーでも途中ファイルを消さない（次回は再開できる）', async () => {
    await writeFile(`${dest}.part`, '01234', 'utf8')
    const impl = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl })).rejects.toMatchObject({
      kind: 'network',
      resumable: true
    })
    expect(await partialDownloadSize(dest)).toBe(5)
  })

  it('サイズが合わなければ不完全として扱い、途中ファイルを残す', async () => {
    const impl = (async () =>
      new Response('short', { status: 200, headers: { 'content-length': '999' } })) as unknown as typeof fetch

    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 999 })).rejects.toMatchObject({
      kind: 'incomplete',
      resumable: true
    })
    expect(existsSync(dest)).toBe(false)
    expect(await partialDownloadSize(dest)).toBe(5)
  })

  it('途中ファイルを捨ててやり直せる', async () => {
    await writeFile(`${dest}.part`, '01234', 'utf8')
    expect(await partialDownloadSize(dest)).toBe(5)
    await discardPartialDownload(dest)
    expect(await partialDownloadSize(dest)).toBe(0)
  })

  it('中断したら aborted として扱う', async () => {
    const controller = new AbortController()
    const impl = (async () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }) as unknown as typeof fetch
    controller.abort()

    await expect(
      downloadWhisperModel('small', dest, { fetchImpl: impl, signal: controller.signal })
    ).rejects.toMatchObject({ kind: 'aborted' })
  })
})

/** 終わらない本文（長さの宣言なし）。読まれた分だけ数える */
function endlessFetch(options: { status?: number; headers?: Record<string, string> } = {}) {
  const state = { pulled: 0 }
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const chunk = new Uint8Array(1024).fill(0x61)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += chunk.length
        controller.enqueue(chunk)
      }
    })
    init?.signal?.addEventListener('abort', () => body.cancel().catch(() => undefined))
    return new Response(body, { status: options.status ?? 200, headers: options.headers ?? {} })
  }) as unknown as typeof fetch
  return { impl, state }
}

describe('security-2 [9] モデルのダウンロード: 決まった大きさと期限（レポート1回目 [12]）', () => {
  it('終わらない応答は、決まった大きさを超えた時点で止めて途中ファイルを消す', async () => {
    const { impl, state } = endlessFetch()
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 10_000 })).rejects.toMatchObject({
      kind: 'incomplete',
      resumable: false
    })
    // 決まった大きさ＋ストリームの先読み程度で止まる
    expect(state.pulled).toBeLessThan(10_000 + 64 * 1024)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })

  it('宣言の長さが決まった大きさと違えば、読まずに断る', async () => {
    const { impl, state } = endlessFetch({ headers: { 'content-length': String(10 * 1024 * 1024 * 1024) } })
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 10_000 })).rejects.toMatchObject({
      kind: 'incomplete',
      resumable: false
    })
    expect(state.pulled).toBeLessThan(64 * 1024)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('再開の応答が大きすぎる（宣言なし）ときも、決まった大きさで止めて途中ファイルを消す', async () => {
    await writeFile(`${dest}.part`, 'x'.repeat(5000), 'utf8')
    const { impl, state } = endlessFetch({ status: 206 })
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 10_000 })).rejects.toMatchObject({
      kind: 'incomplete',
      resumable: false
    })
    expect(state.pulled).toBeLessThan(5000 + 64 * 1024)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('再開の位置（Content-Range）が途中ファイルの末尾と違えば、つなげずに断る', async () => {
    await writeFile(`${dest}.part`, '01234', 'utf8')
    const impl = (async () => new Response('3456789', {
      status: 206,
      headers: { 'content-range': 'bytes 3-9/10', 'content-length': '7' }
    })) as unknown as typeof fetch
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 10, sha256: sha('0123456789') })).rejects.toMatchObject({
      kind: 'incomplete',
      resumable: false
    })
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('決まった大きさより大きい途中ファイルは捨てて最初から取る', async () => {
    await writeFile(`${dest}.part`, 'x'.repeat(50), 'utf8')
    const { impl, calls } = fakeFetch('0123456789')
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })
    expect(calls[0]).toBeUndefined()
    expect(await readFile(dest, 'utf8')).toBe('0123456789')
  })

  it('受け取り終えた途中ファイルは、取り直さずに照合だけして置く', async () => {
    await writeFile(`${dest}.part`, '0123456789', 'utf8')
    const { impl, calls } = fakeFetch('NEW')
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })
    expect(calls).toHaveLength(0)
    expect(await readFile(dest, 'utf8')).toBe('0123456789')
  })

  it('データが止まったら内部の期限で止め、途中ファイルを残す（次回は続きから）', async () => {
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('01234')) },
        // 以後は何も送らない
        pull() { return new Promise(() => undefined) }
      })
      init?.signal?.addEventListener('abort', () => body.cancel().catch(() => undefined))
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const started = Date.now()
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 10, stallTimeoutMs: 100 })).rejects.toMatchObject({
      kind: 'network',
      resumable: true
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await partialDownloadSize(dest)).toBe(5)
  })

  it('応答が来なければ内部の期限で止める', async () => {
    const impl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })) as unknown as typeof fetch
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 10, connectTimeoutMs: 50 })).rejects.toMatchObject({
      kind: 'network'
    })
  })
})

describe('security-2 [9] モデルのダウンロード: 転送先と照合', () => {
  /** 1回目は Location で転送し、2回目以降は本文を返す fetch */
  function redirectingFetch(location: string, body: string) {
    const urls: string[] = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url))
      expect(init?.redirect).toBe('manual')
      if (urls.length === 1) return new Response(null, { status: 302, headers: { location } })
      return new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } })
    }) as unknown as typeof fetch
    return { impl, urls }
  }

  it('配布元の配信用ホストへの転送はたどる', async () => {
    const { impl, urls } = redirectingFetch('https://cas-bridge.xethub.hf.co/x/ggml-small.bin?sig=1', '0123456789')
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })
    expect(urls[1]).toMatch(/^https:\/\/cas-bridge\.xethub\.hf\.co\//)
    expect(await readFile(dest, 'utf8')).toBe('0123456789')
  })

  for (const target of ['https://evil.example/ggml-small.bin', 'http://huggingface.co/x', 'file:///etc/passwd', 'https://huggingface.co.evil.example/x']) {
    it(`許していない先への転送はたどらない: ${target}`, async () => {
      const { impl, urls } = redirectingFetch(target, '0123456789')
      await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })).rejects.toMatchObject({ kind: 'http' })
      expect(urls).toHaveLength(1)
      expect(existsSync(dest)).toBe(false)
    })
  }

  it('転送が続きすぎたら止める', async () => {
    let n = 0
    const impl = (async () => { n++; return new Response(null, { status: 302, headers: { location: `https://huggingface.co/loop/${n}` } }) }) as unknown as typeof fetch
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, expectedBytes: 10 })).rejects.toMatchObject({ kind: 'http' })
    expect(n).toBeLessThanOrEqual(6)
  })

  it('大きさは合っていても sha256 が違えば使わない（置いてあるモデルも置き換えない）', async () => {
    const { impl } = fakeFetch('9876543210')
    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })).rejects.toMatchObject({ kind: 'checksum', resumable: false })
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
    await writeFile(dest, 'INSTALLED', 'utf8')
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), expectedBytes: 10 })
    expect(await readFile(dest, 'utf8')).toBe('INSTALLED')
  })

  it('取ってよい先は Hugging Face の https だけ', () => {
    expect(isAllowedModelUrl('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin')).toBe(true)
    expect(isAllowedModelUrl('https://cdn-lfs.huggingface.co/x')).toBe(true)
    expect(isAllowedModelUrl('https://user:pw@huggingface.co/x')).toBe(false)
    expect(isAllowedModelUrl('https://evilhuggingface.co/x')).toBe(false)
  })
})
