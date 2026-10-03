import { BrowserWindow, ipcMain, nativeImage, type NativeImage, type WebContents } from 'electron'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { AudioLevel, PcmBlock, RecordingOptions } from './types'
import { t } from '@shared/i18n'

/**
 * 録画用の非表示ウィンドウ（設計4章）。
 *
 * MediaRecorder と getUserMedia はレンダラにしか無いので、録画はこのウィンドウで動かす。
 * **UIのウィンドウとは別にする**のが肝で、モード切替や再描画でUIが作り直されても
 * 録画は切れない。ウィンドウは最後まで `show: false` のままで、画面にも
 * 画面共有にも出ない（MTG中に他アプリを前面にしても録り続けられる）。
 *
 * 動画は `timeslice` ごとに届く塊をそのままファイルへ追記する。
 * アプリが落ちても、その時点までのWebMが残る（NF-12）。
 */

/** main ⇄ 録画ウィンドウ のチャネル。アプリ本体のIPCとは混ぜない */
export const RECORDER_CHANNELS = {
  start: 'ade-recorder:start',
  pause: 'ade-recorder:pause',
  resume: 'ade-recorder:resume',
  stop: 'ade-recorder:stop',
  video: 'ade-recorder:video',
  pcm: 'ade-recorder:pcm',
  level: 'ade-recorder:level',
  ready: 'ade-recorder:ready',
  error: 'ade-recorder:error',
  stopped: 'ade-recorder:stopped',
  started: 'ade-recorder:started',
  grab: 'ade-recorder:grab',
  frame: 'ade-recorder:frame'
} as const

/**
 * 映像の取り込み元。
 * - tab: 内蔵ブラウザの webContents（タブ録画。OSの画面収録の許可は要らない）
 * - desktop: desktopCapturer の画面・ウインドウ（'screen:…' / 'window:…'）
 */
export type VideoSource = { kind: 'tab'; contents: WebContents } | { kind: 'desktop'; sourceId: string }

export interface RecorderWindowHandlers {
  onPcm(block: PcmBlock): void
  onLevel(level: AudioLevel): void
  onError(message: string): void
}

interface StartPayload {
  sourceKind: 'tab' | 'desktop'
  sourceId: string
  startedAtEpoch: number
  captureMic: boolean
  syntheticMicWavBase64?: string
  syntheticMic: boolean
  captureSystemAudio: boolean
  micDeviceId?: string
  videoBitsPerSecond: number
  videoMaxWidth: number
  videoMaxFrameRate: number
  videoTimesliceMs: number
  /** 録画ウィンドウが出すエラーの文。画面の言語で main が組み立てて渡す（録画ウィンドウは辞書を持たない） */
  messages: Record<'videoEnded' | 'videoFailed' | 'micFailed' | 'systemAudioFailed' | 'noAudioTrack', string>
}

export class RecorderWindow {
  private window: BrowserWindow | null = null
  private videoStream: WriteStream | null = null
  private bytesWritten = 0
  private stoppedResolve: (() => void) | null = null
  private startedResolve: (() => void) | null = null
  private grabSeq = 0
  private readonly grabs = new Map<number, (png: ArrayBuffer | null) => void>()
  private readonly listeners: Array<
    [string, (event: Electron.IpcMainEvent, ...args: unknown[]) => void]
  > = []

  constructor(
    private readonly htmlPath: string,
    private readonly preloadPath: string,
    private readonly handlers: RecorderWindowHandlers
  ) {}

  get videoBytes(): number {
    return this.bytesWritten
  }

  /** 起動を軽くするため、録画を始めるときに初めて作る */
  async open(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 非表示ウィンドウはタイマーが絞られる。録画中は絞らせない
        backgroundThrottling: false
      }
    })
    this.window = window
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.warn('[recorder]', message)
    })
    this.bind()
    await window.loadFile(this.htmlPath)
  }

  private bind(): void {
    const add = <T extends unknown[]>(
      channel: string,
      handler: (event: Electron.IpcMainEvent, ...args: T) => void
    ): void => {
      const wrapped = (event: Electron.IpcMainEvent, ...args: unknown[]): void => {
        if (event.sender !== this.window?.webContents) return
        handler(event, ...(args as T))
      }
      ipcMain.on(channel, wrapped)
      this.listeners.push([channel, wrapped])
    }

    add<[ArrayBuffer]>(RECORDER_CHANNELS.video, (_event, chunk) => {
      const buffer = Buffer.from(chunk)
      this.bytesWritten += buffer.byteLength
      this.videoStream?.write(buffer)
    })

    add<[{ source: PcmBlock['source']; offsetMs: number; samples: ArrayBuffer }]>(
      RECORDER_CHANNELS.pcm,
      (_event, block) => {
        this.handlers.onPcm({
          source: block.source,
          offsetMs: block.offsetMs,
          samples: new Int16Array(block.samples)
        })
      }
    )

    add<[AudioLevel]>(RECORDER_CHANNELS.level, (_event, level) => this.handlers.onLevel(level))
    add<[string]>(RECORDER_CHANNELS.error, (_event, message) => this.handlers.onError(message))
    add<[]>(RECORDER_CHANNELS.stopped, () => {
      this.stoppedResolve?.()
      this.stoppedResolve = null
    })
    add<[]>(RECORDER_CHANNELS.started, () => this.startedResolve?.())
    add<[number, ArrayBuffer | null]>(RECORDER_CHANNELS.frame, (_event, id, png) => {
      this.grabs.get(id)?.(png)
      this.grabs.delete(id)
    })
  }

  /**
   * 録画を始める。
   * @param source 録りたいもの（内蔵ブラウザの webContents、または画面・ウインドウ）
   */
  async start(source: VideoSource, options: RecordingOptions, startedAtEpoch: number): Promise<void> {
    const window = this.window
    if (!window || window.isDestroyed()) throw new Error(t('recording.errors.noRecorderWindow'))

    this.videoStream = createWriteStream(options.paths.videoPath)
    this.bytesWritten = 0

    // tab は自アプリ内の webContents を指す「タブ録画」のID。OSの画面収録権限は要らない
    const sourceId = source.kind === 'tab' ? source.contents.getMediaSourceId(window.webContents) : source.sourceId
    const payload: StartPayload = {
      sourceKind: source.kind,
      sourceId,
      startedAtEpoch,
      captureMic: options.captureMic,
      syntheticMic: options.syntheticMic === true,
      syntheticMicWavBase64: options.syntheticMicWavBase64,
      captureSystemAudio: options.captureSystemAudio,
      micDeviceId: options.micDeviceId,
      videoBitsPerSecond: options.videoBitsPerSecond,
      videoMaxWidth: options.videoMaxWidth,
      videoMaxFrameRate: options.videoMaxFrameRate,
      videoTimesliceMs: options.videoTimesliceMs,
      // {{message}} / {{source}} は録画ウィンドウ側で埋める
      messages: {
        videoEnded: t('recorder.videoEnded'),
        videoFailed: t('recorder.videoFailed'),
        micFailed: t('recorder.micFailed'),
        systemAudioFailed: t('recorder.systemAudioFailed'),
        noAudioTrack: t('recorder.noAudioTrack')
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('recording.errors.recorderNotReady'))), 15_000)
      this.startedResolve = () => { clearTimeout(timer); this.startedResolve = null; resolve() }
      window.webContents.send(RECORDER_CHANNELS.start, payload)
    })
  }

  /** 録画用ウインドウが閉じた（静止画を撮れない） */
  get gone(): boolean {
    return !this.window || this.window.isDestroyed()
  }

  /**
   * 録画中の映像から1枚切り出す（画面全体・別のウインドウの静止画用）。
   * 内蔵ブラウザなら capturePage() で撮れるが、他のアプリの画面は撮れないため。
   * 映像が届かない（ウインドウが最小化された等）ときは null。
   */
  async grabFrame(timeoutMs = 2000): Promise<NativeImage | null> {
    const window = this.window
    if (!window || window.isDestroyed()) return null
    const id = ++this.grabSeq
    const png = await new Promise<ArrayBuffer | null>((resolve) => {
      const timer = setTimeout(() => { this.grabs.delete(id); resolve(null) }, timeoutMs)
      timer.unref?.()
      this.grabs.set(id, (data) => { clearTimeout(timer); resolve(data) })
      window.webContents.send(RECORDER_CHANNELS.grab, id)
    })
    if (!png || png.byteLength === 0) return null
    const image = nativeImage.createFromBuffer(Buffer.from(png))
    return image.isEmpty() ? null : image
  }

  pause(): void {
    this.window?.webContents.send(RECORDER_CHANNELS.pause)
  }

  resume(): void {
    this.window?.webContents.send(RECORDER_CHANNELS.resume)
  }

  /** 停止して、最後のチャンクが書き終わるまで待つ */
  async stop(timeoutMs = 5000): Promise<void> {
    const window = this.window
    if (!window || window.isDestroyed()) return
    const stopped = new Promise<void>((resolve) => {
      this.stoppedResolve = resolve
      setTimeout(resolve, timeoutMs).unref?.()
    })
    window.webContents.send(RECORDER_CHANNELS.stop)
    await stopped
    await new Promise<void>((resolve) => {
      if (!this.videoStream) return resolve()
      this.videoStream.end(() => resolve())
    })
    this.videoStream = null
  }

  dispose(): void {
    for (const [channel, handler] of this.listeners) ipcMain.off(channel, handler)
    this.listeners.length = 0
    for (const resolve of this.grabs.values()) resolve(null)
    this.grabs.clear()
    this.videoStream?.end()
    this.videoStream = null
    const window = this.window
    this.window = null
    if (window && !window.isDestroyed()) window.destroy()
  }
}

/** 既定の配置（electron-vite の out/ を前提にした相対パス） */
export function defaultRecorderAssets(dirname: string): { html: string; preload: string } {
  return {
    html: join(dirname, '../recorder/index.html'),
    preload: join(dirname, '../preload/recorder.js')
  }
}
