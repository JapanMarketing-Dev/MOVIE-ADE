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
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('MODEL-BYTES') })
    expect(await readFile(dest, 'utf8')).toBe('MODEL-BYTES')
    // 途中ファイルは残らない
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('進捗を通知する', async () => {
    const { impl } = fakeFetch('0123456789')
    const seen: DownloadProgress[] = []
    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789'), onProgress: (p) => seen.push(p) })

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

    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789') })
    expect(calls[0]).toBe('bytes=5-')
    expect(await readFile(dest, 'utf8')).toBe('0123456789')
  })

  it('サーバーが Range を無視したら最初から取り直す', async () => {
    await writeFile(`${dest}.part`, '01234', 'utf8')
    const { impl } = fakeFetch('0123456789', { honorRange: false })

    await downloadWhisperModel('small', dest, { fetchImpl: impl, sha256: sha('0123456789') })
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

    await expect(downloadWhisperModel('small', dest, { fetchImpl: impl })).rejects.toMatchObject({
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
