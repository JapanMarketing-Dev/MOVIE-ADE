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
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WhisperModelId } from './models'
import { whisperModels } from './models'
import { t } from '@shared/i18n'

export interface DownloadProgress {
  modelId: WhisperModelId
  receivedBytes: number
  /** 全体のサイズ（決まったモデルの大きさ）。分からない場合は undefined */
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
  /** 決まったファイルの大きさ(バイト)。既定は models.ts の値。超えたらその場で止めて捨てる */
  expectedBytes?: number
  /** 応答（ヘッダー）が来るまでの上限 */
  connectTimeoutMs?: number
  /** データが1バイトも届かないまま過ぎたら止める時間 */
  stallTimeoutMs?: number
  /** 1回のダウンロード全体の上限（止めても .part は残り、次回は続きから） */
  maxDurationMs?: number
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
const CONNECT_TIMEOUT_MS = 30_000
const STALL_TIMEOUT_MS = 60_000
/** 1.5GB を 1Mbps 前後でも落とせる長さ。超えても続きから再開できる */
const MAX_DURATION_MS = 6 * 60 * 60 * 1000

/** 内部の期限で止めた（利用者の中断と見分ける） */
class DownloadTimeout extends Error {
  constructor() {
    super('model download timed out')
    this.name = 'DownloadTimeout'
  }
}

/** 決まった大きさを超えるデータが来た */
class DownloadTooLarge extends Error {}

/** 転送（リダイレクト）をたどる回数の上限 */
const MAX_REDIRECTS = 5

/**
 * モデルを取ってよい先か。配布元（Hugging Face）とその配信用のホストの https だけ。
 * 転送の先が別のホストに向いていたら、たどらない（乗っ取られた転送でほかの場所から落とさない）
 */
export function isAllowedModelUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // 読めない URL はたどらない（想定内）
    return false
  }
  const host = u.hostname.toLowerCase()
  return u.protocol === 'https:' && !u.username && !u.password &&
    (host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co'))
}

/** 転送を自分でたどる。たどる先は isAllowedModelUrl のものだけ、回数は MAX_REDIRECTS まで */
async function fetchFollowingAllowedRedirects(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let current = url
  for (let hop = 0; ; hop++) {
    if (!isAllowedModelUrl(current)) {
      throw new ModelDownloadError(t('stt.download.badRedirect'), 'http', false)
    }
    const res = await doFetch(current, { ...init, redirect: 'manual' })
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return res
    // 転送の本文は読まない
    await res.body?.cancel().catch(() => undefined)
    if (hop >= MAX_REDIRECTS) throw new ModelDownloadError(t('stt.download.badRedirect'), 'http', false)
    current = new URL(location, current).toString()
  }
}

/** Content-Range（bytes 開始-終了/全体）。読めなければ null */
function parseContentRange(value: string | null): { start: number; total: number | null } | null {
  const m = value ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim()) : null
  if (!m) return null
  return { start: Number(m[1]), total: m[3] === '*' ? null : Number(m[3]) }
}

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
  const expectedBytes = options.expectedBytes ?? info.bytes

  if (await exists(destPath)) return
  await mkdir(dirname(destPath), { recursive: true })

  let already = await sizeOf(partPath)
  if (already > expectedBytes) {
    // 決まった大きさより大きい途中ファイルは壊れている。続きから取らずに捨てる
    await unlink(partPath).catch(() => undefined)
    already = 0
  }
  // 受け取り終えていれば、取り直さずに照合だけする（Range が範囲外になるため）
  if (already === expectedBytes) return finish(partPath, destPath, info.sha256, options)
  const resumed = already > 0

  // 内部の期限。応答までの時間・データが止まった時間・全体の時間のどれかを過ぎたら止める
  const internal = new AbortController()
  const expire = () => internal.abort(new DownloadTimeout())
  let stallTimer = setTimeout(expire, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
  const deadline = setTimeout(expire, options.maxDurationMs ?? MAX_DURATION_MS)
  const touch = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(expire, options.stallTimeoutMs ?? STALL_TIMEOUT_MS)
  }
  const signal = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal
  const timedOut = () => internal.signal.aborted && !options.signal?.aborted
  const abortError = (resumable: boolean) => timedOut()
    ? new ModelDownloadError(t('stt.download.timeout'), 'network', resumable)
    : new ModelDownloadError(t('stt.download.aborted'), 'aborted', resumable)
  try {
    await fetchToPart()
  } finally {
    clearTimeout(stallTimer)
    clearTimeout(deadline)
  }
  await finish(partPath, destPath, info.sha256, options)

  async function fetchToPart(): Promise<void> {
    let res: Response
    try {
      res = await fetchFollowingAllowedRedirects(doFetch, info.url, {
        headers: resumed ? { Range: `bytes=${already}-` } : {},
        signal
      })
    } catch (e) {
      // 許していない転送先。途中ファイルはそのまま残す
      if (e instanceof ModelDownloadError) throw new ModelDownloadError(e.message, e.kind, resumed)
      if (isAbort(e) || signal.aborted) throw abortError(resumed)
      throw new ModelDownloadError(
        t('stt.download.network', { message: e instanceof Error ? e.message : String(e) }),
        'network',
        resumed
      )
    }
    touch()

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
    const rejectSize = async (got: number): Promise<never> => {
      // 決まった大きさと合わない応答は読まずに断る。続きの位置も信用できないので途中ファイルも捨てる
      await res.body?.cancel().catch(() => undefined)
      await unlink(partPath).catch(() => undefined)
      throw new ModelDownloadError(t('stt.download.size', { got, total: expectedBytes }), 'incomplete', false)
    }
    if (res.status === 206) {
      // 続きの位置がこちらの途中ファイルの末尾と違えば、つなげると壊れる
      const range = parseContentRange(res.headers.get('content-range'))
      if (range && (range.start !== already || (range.total !== null && range.total !== expectedBytes))) {
        await rejectSize(range.total ?? range.start)
      }
    }
    const rawLength = res.headers.get('content-length')
    const contentLength = rawLength !== null && /^\d+$/.test(rawLength.trim()) ? Number(rawLength.trim()) : undefined
    if (contentLength !== undefined && offset + contentLength !== expectedBytes) await rejectSize(offset + contentLength)
    const totalBytes = expectedBytes

    let received = offset
    let lastNotify = 0
    const notify = (force = false) => {
      const now = Date.now()
      if (!force && now - lastNotify < PROGRESS_INTERVAL_MS) return
      lastNotify = now
      options.onProgress?.({
        modelId,
        receivedBytes: received,
        totalBytes,
        ratio: received / totalBytes,
        resumed: resumed && !startsOver
      })
    }
    notify(true)

    const out = createWriteStream(partPath, startsOver ? { flags: 'w' } : { flags: 'a' })
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0], { signal })
    // 数えながら書く。決まった大きさを超えたら、その場で止める（宣言の無い・偽りの長さの応答でも書き続けない）
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        touch()
        if (received + chunk.length > expectedBytes) {
          callback(new DownloadTooLarge())
          return
        }
        received += chunk.length
        notify()
        callback(null, chunk)
      }
    })

    try {
      await pipeline(source, limit, out, { signal })
    } catch (e) {
      if (e instanceof DownloadTooLarge) {
        // 超えた途中ファイルは使えないので消す
        await unlink(partPath).catch(() => undefined)
        throw new ModelDownloadError(t('stt.download.tooLarge'), 'incomplete', false)
      }
      // .part は消さない（次回の再開に使う）
      if (isAbort(e) || signal.aborted) throw abortError(true)
      throw new ModelDownloadError(
        t('stt.download.save', { message: e instanceof Error ? e.message : String(e) }),
        'network',
        true
      )
    }
    notify(true)

    const got = await sizeOf(partPath)
    if (got !== totalBytes) {
      throw new ModelDownloadError(
        t('stt.download.size', { got, total: totalBytes }),
        'incomplete',
        true
      )
    }
  }
}

/** 受け取り終えた .part を照合して、所定の名前へ置く */
async function finish(partPath: string, destPath: string, pinnedSha256: string, options: DownloadOptions): Promise<void> {
  // 壊れた・差し替えられたファイルを使わない。合わなければ続きからの再開もできないので捨てる
  options.onVerifying?.()
  const expected = (options.sha256 ?? pinnedSha256).toLowerCase()
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
