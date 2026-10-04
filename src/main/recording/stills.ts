import { delay } from '@shared/delay'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeImage, WebContents } from 'electron'
import type { FrameRef } from '../pipeline/types'
import type { RecordingClock } from './clock'
import type { RecordingOptions } from './types'
import { frameFileName, hasChanged, isNearlyBlank, targetWidth } from './frames'
// 静止画の時刻を t と呼ぶので、文の取り出しは別名にする
import { t as translateMessage } from '@shared/i18n'
import { reportHandled } from '@shared/report'

/**
 * 静止画の収集（設計4章）。
 *
 * `capturePage()` を0.5秒ごとに回し、**画面が変わったときだけ**保存する。
 * 動画から切り出すより鮮明で、時刻で正確に選べる（EXT-3）。
 * ペン・テキストの確定時とクリック時は、間隔を待たずにその場で撮る。
 *
 * 変化の判定は、撮った画像を 32px 幅へ縮めてハッシュを取り、直前と比べる方式。
 * 全画素を比べないので、0.5秒ごとに回しても負荷が小さい。
 *
 * 撮る元は StillSource で差し替える。内蔵ブラウザは `capturePage()`、
 * 画面全体・別のウインドウは録画中の映像トラックから1枚切り出す（recorderWindow.ts）。
 */

/** 静止画を1枚撮る元 */
export interface StillSource {
  capture(): Promise<NativeImage | null>
  /** もう撮れない（ビューが破棄された・録画用ウインドウが閉じた） */
  readonly gone: boolean
}

/** 内蔵ブラウザの webContents から撮る */
export function webContentsStillSource(contents: WebContents): StillSource {
  return {
    capture: () => contents.capturePage(),
    get gone() { return contents.isDestroyed() }
  }
}

/**
 * 1回の録画の静止画の上限（CWE-400 への備え）。超えたら保存をやめて1度だけ知らせる（声と動画は続ける）。
 * 0.5秒ごとの撮影は画面が変わったときだけ保存するので、ふつうの録画ではまず届かない。
 */
interface StillLimits {
  maxCount: number
  maxBytes: number
  /** 撮る予定の強制撮影（クリック・ペン・遷移）の数の上限。超えた分は撮らない */
  maxPendingForced: number
  /** クリックでの強制撮影の最短の間隔(ms)。連打では最初の1枚と定期撮影に任せる */
  minClickIntervalMs: number
}

const DEFAULT_STILL_LIMITS: StillLimits = {
  maxCount: 20_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxPendingForced: 4,
  minClickIntervalMs: 250
}

/**
 * 撮りかけの静止画を待つ上限(ms)。capturePage が返ってこなくても、停止やページ遷移を待たせ続けない
 * （撮る予定は maxPendingForced 件までなので、ふつうはすぐ終わる）
 */
const SETTLE_TIMEOUT_MS = 5_000

/** 計測用の所要時間を残す数（録画が長くても増え続けないように） */
const MAX_TIMINGS = 1000

interface StillCaptureHandlers {
  getCursor?(): { x: number; y: number; view?: { width: number; height: number } } | undefined
  onFrame(frame: FrameRef): void
  onWarning(message: string): void
}

export class StillCapturer {
  private timer: NodeJS.Timeout | null = null
  private previous: Uint8Array | null = null
  private seq = 0
  private busy = false
  private pendingForced = 0
  private lastClickForcedAt = -Infinity
  private savedBytes = 0
  private limitReached = false
  /** 停止を始めたら、新しい強制撮影は受け付けない */
  private stopping = false
  private readonly frames: FrameRef[] = []
  /** 計測用。1枚あたりの所要時間(ms) */
  readonly timings: number[] = []

  constructor(
    private readonly source: StillSource,
    private readonly clock: RecordingClock,
    private readonly options: RecordingOptions,
    private readonly handlers: StillCaptureHandlers,
    private readonly limits: StillLimits = DEFAULT_STILL_LIMITS,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick('interval'), this.options.stillIntervalMs)
    this.timer.unref?.()
    void this.tick('start')
  }

  pause(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  resume(): void {
    this.start()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.pause()
    await this.settle()
  }

  /** 撮りかけ・撮る予定の静止画が書き終わるまで待つ（定期撮影は止めない）。待つのは timeoutMs まで */
  async settle(timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    const deadline = this.now() + timeoutMs
    while ((this.busy || this.pendingForced) && this.now() < deadline) await delay(10)
  }

  get captured(): FrameRef[] {
    return this.frames
  }

  /**
   * いますぐ撮る。ペンの確定時とクリック時に呼ぶ。
   * `force` のときは変化がなくても保存する（その瞬間の画像が指摘の根拠になるため）。
   */
  async captureNow(reason: string, cursor?: { x: number; y: number; view?: { width: number; height: number } }, annotationId?: string): Promise<FrameRef | null> {
    // 撮る予定が詰まっているとき・上限に達したときは撮らない（ページが合成のクリックを大量に起こしても積み上げない）
    if (this.stopping || this.limitReached || this.pendingForced >= this.limits.maxPendingForced) return null
    if (reason === 'click') {
      const now = this.now()
      if (now - this.lastClickForcedAt < this.limits.minClickIntervalMs) return null
      this.lastClickForcedAt = now
    }
    this.pendingForced++
    try {
      // 注入側のDOM更新が合成器に描画されてから撮る。
      if (annotationId) await delay(40)
      // 定期撮影と重なっても、確定した書き込みの根拠画像は落とさない。
      while (this.busy) await delay(10)
      return await this.tick(reason, true, cursor, annotationId)
    } finally { this.pendingForced-- }
  }

  private async tick(
    reason: string,
    force = false,
    cursor?: { x: number; y: number; view?: { width: number; height: number } },
    annotationId?: string
  ): Promise<FrameRef | null> {
    // 前の撮影が終わっていないときは飛ばす（録画中の操作を重くしない。NF-4）
    if (this.busy) return null
    if (this.source.gone || this.limitReached) return null
    this.busy = true
    const t = this.clock.now()
    const startedAt = Date.now()
    try {
      // 遷移の直後は合成器がまだ準備できておらず UnknownVizError になることがある。
      // 1度だけ待って撮り直す
      // 撮れなければ1度だけ撮り直す（想定内）
      let image = await this.source.capture().catch(() => null)
      if (!image || image.isEmpty()) {
        await delay(120)
        if (this.source.gone) return null
        image = await this.source.capture().catch(() => null)
      }
      if (!image || image.isEmpty()) return null

      const signature = fingerprint(image)
      if (!force && !hasChanged(this.previous, signature)) return null
      this.previous = signature

      const name = frameFileName(++this.seq, this.options.stillFormat)
      const path = join(this.options.paths.framesDir, name)
      const width = targetWidth(image.getSize().width, this.options.stillMaxWidth)
      const saved = width === null ? image : image.resize({ width, quality: 'better' })
      const data =
        this.options.stillFormat === 'jpeg' ? saved.toJPEG(this.options.stillQuality) : saved.toPNG()
      if (this.frames.length >= this.limits.maxCount || this.savedBytes + data.length > this.limits.maxBytes) {
        this.limitReached = true
        this.handlers.onWarning(translateMessage('recording.errors.stillsLimitReached'))
        return null
      }
      // 既にある名前・リンクには書かない（録画のフォルダは作ったばかりで、名前は通し番号）
      await writeFile(path, data, { flag: 'wx' })
      this.savedBytes += data.length

      cursor ??= this.handlers.getCursor?.()
      const size = saved.getSize()
      const scaled = cursor?.view && cursor.view.width > 0 && cursor.view.height > 0 ? { x: cursor.x / cursor.view.width * size.width, y: cursor.y / cursor.view.height * size.height } : undefined
      const frame: FrameRef = { t, path: name, size, ...(annotationId ? { annotationId } : {}), ...(scaled ? { cursor: scaled } : {}),
        ...(isNearlyBlank(signature) ? { blank: true } : {}) }
      this.frames.push(frame)
      this.handlers.onFrame(frame)
      return frame
    } catch (err) {
      reportHandled(err, { area: 'recording', op: 'save still' })
      this.handlers.onWarning(translateMessage('recording.errors.stillFailed', { reason, error: String(err) }))
      return null
    } finally {
      this.timings.push(Date.now() - startedAt)
      if (this.timings.length > MAX_TIMINGS) this.timings.splice(0, this.timings.length - MAX_TIMINGS)
      this.busy = false
    }
  }
}

/** 32px幅へ縮めた生画素。重複排除の比較に使う */
function fingerprint(image: NativeImage): Uint8Array {
  return new Uint8Array(image.resize({ width: 32, quality: 'good' }).toBitmap())
}
