import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeImage, WebContents } from 'electron'
import type { FrameRef } from '../pipeline/types'
import type { RecordingClock } from './clock'
import type { RecordingOptions } from './types'
import { frameFileName, hasChanged, targetWidth } from './frames'
// 静止画の時刻を t と呼ぶので、文の取り出しは別名にする
import { t as translateMessage } from '@shared/i18n'

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

export interface StillCaptureHandlers {
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
  private readonly frames: FrameRef[] = []
  /** 入力中の書き込みごとに控えた画面（prepare） */
  private readonly prepared = new Map<string, { image: NativeImage; t: number }>()
  /** 計測用。1枚あたりの所要時間(ms) */
  readonly timings: number[] = []

  constructor(
    private readonly source: StillSource,
    private readonly clock: RecordingClock,
    private readonly options: RecordingOptions,
    private readonly handlers: StillCaptureHandlers
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
    this.pause()
    await this.settle()
  }

  /** 撮りかけ・撮る予定の静止画が書き終わるまで待つ（定期撮影は止めない） */
  async settle(): Promise<void> {
    while (this.busy || this.pendingForced) await new Promise((done) => setTimeout(done, 10))
  }

  get captured(): FrameRef[] {
    return this.frames
  }

  /**
   * いますぐ撮る。ペン・テキストの確定時とクリック時に呼ぶ。
   * `force` のときは変化がなくても保存する（その瞬間の画像が指摘の根拠になるため）。
   */
  async captureNow(reason: string, cursor?: { x: number; y: number; view?: { width: number; height: number } }, annotationId?: string, usePrepared = false): Promise<FrameRef | null> {
    this.pendingForced++
    try {
      // ページを離れるために確定した書き込みは、入力中に控えた画面を使う（いまの画面は次のページ）
      const preset = usePrepared && annotationId ? this.prepared.get(annotationId) : undefined
      if (annotationId) this.prepared.delete(annotationId)
      // 注入側のDOM更新が合成器に描画されてから撮る。
      if (annotationId && !preset) await new Promise((done) => setTimeout(done, 40))
      // 定期撮影と重なっても、確定した書き込みの根拠画像は落とさない。
      while (this.busy) await new Promise((done) => setTimeout(done, 10))
      return await this.tick(reason, true, cursor, annotationId, preset)
    } finally { this.pendingForced-- }
  }

  /**
   * 入力中の書き込み（吹き出し）が写った画面を控える。保存はしない。
   * SPA の遷移で書きかけのまま確定したとき、captureNow(…, usePrepared) がこれを使う。
   */
  async prepare(annotationId: string): Promise<void> {
    if (this.source.gone) return
    const t = this.clock.now()
    const image = await this.source.capture().catch(() => null)
    if (!image || image.isEmpty()) return
    this.prepared.delete(annotationId)
    this.prepared.set(annotationId, { image, t })
    // 確定されずに消えた吹き出しの控えを溜め込まない
    while (this.prepared.size > 4) this.prepared.delete(this.prepared.keys().next().value!)
  }

  private async tick(
    reason: string,
    force = false,
    cursor?: { x: number; y: number; view?: { width: number; height: number } },
    annotationId?: string,
    /** 撮らずにこの画面を使う（prepare で控えたもの） */
    preset?: { image: NativeImage; t: number }
  ): Promise<FrameRef | null> {
    // 前の撮影が終わっていないときは飛ばす（録画中の操作を重くしない。NF-4）
    if (this.busy) return null
    if (this.source.gone && !preset) return null
    this.busy = true
    const t = preset?.t ?? this.clock.now()
    const startedAt = Date.now()
    try {
      // 遷移の直後は合成器がまだ準備できておらず UnknownVizError になることがある。
      // 1度だけ待って撮り直す
      let image = preset?.image ?? await this.source.capture().catch(() => null)
      if (!image || image.isEmpty()) {
        await new Promise((done) => setTimeout(done, 120))
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
      await writeFile(path, data)

      cursor ??= this.handlers.getCursor?.()
      const size = saved.getSize()
      const scaled = cursor?.view && cursor.view.width > 0 && cursor.view.height > 0 ? { x: cursor.x / cursor.view.width * size.width, y: cursor.y / cursor.view.height * size.height } : undefined
      const frame: FrameRef = { t, path: name, size, ...(annotationId ? { annotationId } : {}), ...(scaled ? { cursor: scaled } : {}) }
      this.frames.push(frame)
      this.handlers.onFrame(frame)
      return frame
    } catch (err) {
      this.handlers.onWarning(translateMessage('recording.errors.stillFailed', { reason, error: String(err) }))
      return null
    } finally {
      this.timings.push(Date.now() - startedAt)
      this.busy = false
    }
  }
}

/** 32px幅へ縮めた生画素。重複排除の比較に使う */
function fingerprint(image: NativeImage): Uint8Array {
  return new Uint8Array(image.resize({ width: 32, quality: 'good' }).toBitmap())
}
