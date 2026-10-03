/**
 * whisper のモデルのダウンロード。
 *
 * モデルは同梱せず初回に落とす（設計 1.1 / 5章①）。`large-v3-turbo` は1.5GBあるため、
 * 進捗の通知と中断からの再開（HTTP Range）を用意する。
 * Electron には依存しない（通知はコールバック）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WhisperModelId } from './models'
import { whisperModels } from './models'
import { t } from '@shared/i18n'

export interface DownloadProgress {
  modelId: WhisperModelId
  receivedBytes: number
  /** サーバーが返した全体のサイズ。分からない場合は undefined */
  totalBytes?: number
  /** 0〜1。totalBytes が不明なら undefined */
  ratio?: number
  /** 再開したダウンロードか */
  resumed: boolean
}

export interface DownloadOptions {
  /** 進捗の通知。UIへ流す。呼ばれる頻度は最大で10回/秒 */
  onProgress?: (progress: DownloadProgress) => void
  /** 中断用 */
  signal?: AbortSignal
  /** 差し替え用（テスト） */
  fetchImpl?: typeof fetch
  /** 照合する sha256。既定は models.ts の値（テストで小さなデータに差し替える） */
  sha256?: string
  /** 受け取り終えて sha256 を照合し始めたとき（1.5GB で数秒かかる） */
  onVerifying?: () => void
}

export class ModelDownloadError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http' | 'aborted' | 'incomplete' | 'checksum',
    /** 途中までのファイル（.part）を残したか。残っていれば次回は再開できる */
    readonly resumable: boolean
  ) {
    super(message)
    this.name = 'ModelDownloadError'
  }
}

const PROGRESS_INTERVAL_MS = 100

/**
 * モデルを `destPath` へ落とす。
 * 途中までのデータは `<destPath>.part` に置き、次回は Range で続きから取る。
 * 既に完成したファイルがあれば何もしない。
 */
export async function downloadWhisperModel(
  modelId: WhisperModelId,
  destPath: string,
  options: DownloadOptions = {}
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch
  const info = whisperModels[modelId]
  const partPath = `${destPath}.part`

  if (await exists(destPath)) return
  await mkdir(dirname(destPath), { recursive: true })

  const already = await sizeOf(partPath)
  const resumed = already > 0

  let res: Response
  try {
    res = await doFetch(info.url, {
      headers: resumed ? { Range: `bytes=${already}-` } : {},
      ...(options.signal ? { signal: options.signal } : {})
    })
  } catch (e) {
    if (isAbort(e)) throw new ModelDownloadError(t('stt.download.aborted'), 'aborted', resumed)
    throw new ModelDownloadError(
      t('stt.download.network', { message: e instanceof Error ? e.message : String(e) }),
      'network',
      resumed
    )
  }

  // 206 = 続きから。200 = 最初から（サーバーが Range を無視した）
  const startsOver = res.status === 200 && resumed
  if (!res.ok) {
    throw new ModelDownloadError(
      t('stt.download.http', { status: res.status }),
      'http',
      resumed
    )
  }
  if (!res.body) {
    throw new ModelDownloadError(t('stt.download.empty'), 'network', resumed)
  }

  const offset = startsOver ? 0 : already
  const contentLength = Number(res.headers.get('content-length') ?? '')
  const totalBytes = Number.isFinite(contentLength) ? offset + contentLength : undefined

  let received = offset
  let lastNotify = 0
  const notify = (force = false) => {
    const now = Date.now()
    if (!force && now - lastNotify < PROGRESS_INTERVAL_MS) return
    lastNotify = now
    options.onProgress?.({
      modelId,
      receivedBytes: received,
      ...(totalBytes !== undefined ? { totalBytes, ratio: received / totalBytes } : {}),
      resumed: resumed && !startsOver
    })
  }
  notify(true)

  const out = createWriteStream(partPath, startsOver ? { flags: 'w' } : { flags: 'a' })
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    notify()
  })

  try {
    await pipeline(source, out)
  } catch (e) {
    // .part は消さない（次回の再開に使う）
    if (isAbort(e)) throw new ModelDownloadError(t('stt.download.aborted'), 'aborted', true)
    throw new ModelDownloadError(
      t('stt.download.save', { message: e instanceof Error ? e.message : String(e) }),
      'network',
      true
    )
  }
  notify(true)

  if (totalBytes !== undefined) {
    const got = await sizeOf(partPath)
    if (got !== totalBytes) {
      throw new ModelDownloadError(
        t('stt.download.size', { got, total: totalBytes }),
        'incomplete',
        true
      )
    }
  }
  // 壊れた・差し替えられたファイルを使わない。合わなければ続きからの再開もできないので捨てる
  options.onVerifying?.()
  const expected = (options.sha256 ?? info.sha256).toLowerCase()
  if ((await sha256File(partPath, options.signal)) !== expected) {
    // 片付け。消せなくても次の取得で上書きする（想定内）
    await unlink(partPath).catch(() => undefined)
    throw new ModelDownloadError(t('stt.model.checksumMismatch'), 'checksum', false)
  }
  await rename(partPath, destPath)
}

/** ファイルの sha256（16進）。大きなファイルも読み流しで求める */
export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  try {
    await pipeline(createReadStream(path, signal ? { signal } : {}), hash)
  } catch (e) {
    if (isAbort(e)) throw new ModelDownloadError(t('stt.download.aborted'), 'aborted', true)
    throw e
  }
  return hash.digest('hex')
}

/** 途中までのデータを捨てる（やり直したいとき） */
export async function discardPartialDownload(destPath: string): Promise<void> {
  // 途中のファイルが無いこともある（想定内）
  await unlink(`${destPath}.part`).catch(() => undefined)
}

/** 再開できる途中データがあるか、とその大きさ */
export async function partialDownloadSize(destPath: string): Promise<number> {
  return sizeOf(`${destPath}.part`)
}

// 無いことを調べている（想定内）
async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null
}

// 無いファイルは0（想定内）
async function sizeOf(path: string): Promise<number> {
  const s = await stat(path).catch(() => null)
  return s?.isFile() ? s.size : 0
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}
