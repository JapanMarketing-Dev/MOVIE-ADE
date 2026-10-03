/**
 * 設定の「モデルをダウンロード」のテスト。実際の大きなダウンロードはしない（fetch・download を差し替える）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelDownloadError, downloadWhisperModel, partialDownloadSize, sha256File } from '../../src/main/pipeline/stt/download'
import {
  defaultWhisperModel,
  downloadedWhisperModelPath,
  isWhisperModelId,
  selectableWhisperModels,
  whisperModelDir,
  whisperModels,
} from '../../src/main/pipeline/stt/models'
import { WhisperModelDownloads, whisperInstallHint } from '../../src/main/pipeline/stt/modelManager'
import type { WhisperModelProgress } from '@shared/types'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ade-model-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const sha = (body: string) => createHash('sha256').update(body).digest('hex')

describe('ダウンロード先のパスと一覧', () => {
  it('userData/models の下に、配布元と同じファイル名で置く', () => {
    expect(whisperModelDir('/u')).toBe(join('/u', 'models'))
    expect(downloadedWhisperModelPath('/u', 'large-v3-turbo')).toBe(join('/u', 'models', 'ggml-large-v3-turbo.bin'))
    expect(downloadedWhisperModelPath('/u', 'small')).toBe(join('/u', 'models', 'ggml-small.bin'))
  })

  it('どのモデルにも sha256 と正確なサイズがあり、配布元は Hugging Face の ggerganov/whisper.cpp', () => {
    for (const info of Object.values(whisperModels)) {
      expect(info.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(info.bytes).toBeGreaterThan(info.sizeMb * 1_000_000 * 0.9)
      expect(info.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${info.file}`)
    }
  })

  it('既定は日本語・英語で実用になる large-v3-turbo。medium は選択肢に出さない', () => {
    expect(defaultWhisperModel).toBe('large-v3-turbo')
    expect(selectableWhisperModels).toContain('large-v3-turbo')
    expect(selectableWhisperModels).not.toContain('medium')
    expect(isWhisperModelId('small')).toBe(true)
    expect(isWhisperModelId('../../etc/passwd')).toBe(false)
    expect(isWhisperModelId('toString')).toBe(false)
  })

  it('一覧に取得済み・途中まで・おすすめを出す', async () => {
    const downloads = new WhisperModelDownloads(dir, async () => undefined)
    await mkdir(whisperModelDir(dir), { recursive: true })
    await writeFile(downloads.pathOf('small'), 'x')
    await writeFile(`${downloads.pathOf('base')}.part`, '12345')
    const list = await downloads.list()
    expect(list.find((m) => m.id === 'small')).toMatchObject({ downloaded: true, partialBytes: 0, recommended: false })
    expect(list.find((m) => m.id === 'base')).toMatchObject({ downloaded: false, partialBytes: 5 })
    expect(list.find((m) => m.id === 'large-v3-turbo')).toMatchObject({ recommended: true, bytes: whisperModels['large-v3-turbo'].bytes })
  })
})

/** 固定の本文を返す fetch */
const fetchOf = (body: string) => (async () => new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } })) as unknown as typeof fetch

describe('sha256 の検証', () => {
  it('一致すれば所定の名前へ置き、照合の開始を知らせる', async () => {
    const dest = join(dir, 'ggml-small.bin')
    let verifying = false
    await downloadWhisperModel('small', dest, { fetchImpl: fetchOf('MODEL'), sha256: sha('MODEL'), onVerifying: () => { verifying = true } })
    expect(existsSync(dest)).toBe(true)
    expect(verifying).toBe(true)
    expect(await sha256File(dest)).toBe(sha('MODEL'))
  })

  it('一致しなければ途中ファイルも捨て、使わない（再開もしない）', async () => {
    const dest = join(dir, 'ggml-small.bin')
    // 既定の値（本物の small の sha256）とは合わない
    const err = await downloadWhisperModel('small', dest, { fetchImpl: fetchOf('TAMPERED') }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ModelDownloadError)
    expect(err).toMatchObject({ kind: 'checksum', resumable: false })
    expect(existsSync(dest)).toBe(false)
    expect(await partialDownloadSize(dest)).toBe(0)
  })
})

describe('中止', () => {
  it('受信の途中で中止すると aborted になり、途中ファイルを残して次回は続きから', async () => {
    const dest = join(dir, 'ggml-small.bin')
    const controller = new AbortController()
    // 最初の塊を送ったあと止まり、中止されたらエラーになる本文（fetch の本文と同じふるまい）
    const impl = (async (_url: string, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('01234'))
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; c.error(e)
        })
      },
    }), { status: 200, headers: { 'content-length': '10' } })) as unknown as typeof fetch
    const running = downloadWhisperModel('small', dest, { fetchImpl: impl, signal: controller.signal, sha256: sha('0123456789') })
    // 進み具合の通知は 100ms に1回なので、時間で中止する（最初の塊が書かれた後）
    setTimeout(() => controller.abort(), 200)
    await expect(running).rejects.toMatchObject({ kind: 'aborted', resumable: true })
    expect(await partialDownloadSize(dest)).toBe(5)
    expect(existsSync(dest)).toBe(false)
  })

  it('cancel() で中止でき、結果は aborted。同時に2つは落とさない', async () => {
    const downloads = new WhisperModelDownloads(dir, (_id, _dest, options) => new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new ModelDownloadError('中断', 'aborted', true)))
    }))
    expect(downloads.cancel()).toBe(false)
    const first = downloads.start('small')
    expect(downloads.downloading()).toBe('small')
    const second = await downloads.start('base')
    expect(second).toMatchObject({ ok: false, reason: 'failed' })
    expect(downloads.cancel()).toBe(true)
    expect(await first).toMatchObject({ ok: false, reason: 'aborted', resumable: true })
    expect(downloads.downloading()).toBeNull()
  })

  it('成功すれば保存先を返し、進み具合を download → verify の順に流す', async () => {
    const seen: WhisperModelProgress[] = []
    const downloads = new WhisperModelDownloads(dir, async (id, dest, options) => {
      options.onProgress?.({ modelId: id, receivedBytes: 10, totalBytes: 20, ratio: 0.5, resumed: false })
      options.onVerifying?.()
      await mkdir(whisperModelDir(dir), { recursive: true })
      await writeFile(dest, 'ok')
    })
    const r = await downloads.start('small', (p) => seen.push(p))
    expect(r).toEqual({ ok: true, path: downloadedWhisperModelPath(dir, 'small') })
    expect(seen.map((p) => p.phase)).toEqual(['download', 'verify'])
    expect(seen[0]).toMatchObject({ modelId: 'small', receivedBytes: 10, totalBytes: 20 })
  })

  it('失敗は結果で返し、再試行できる', async () => {
    let calls = 0
    const downloads = new WhisperModelDownloads(dir, async () => {
      calls++
      if (calls === 1) throw new ModelDownloadError('HTTP 503', 'http', false)
    })
    expect(await downloads.start('small')).toMatchObject({ ok: false, reason: 'failed', message: 'HTTP 503' })
    expect(await downloads.start('small')).toMatchObject({ ok: true })
  })
})

describe('whisper-cli の入れ方の案内', () => {
  it('macOS は Homebrew、Windows は公式のリリース、Linux はソースからのビルド', () => {
    expect(whisperInstallHint('darwin').command).toBe('brew install whisper-cpp')
    expect(whisperInstallHint('win32')).toEqual({ url: 'https://github.com/ggml-org/whisper.cpp/releases' })
    expect(whisperInstallHint('linux').command).toContain('cmake --build build')
  })
})
