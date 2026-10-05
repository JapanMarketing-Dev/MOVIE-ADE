/**
 * 録画用ウィンドウの中身（レンダラ）。画面には出ない。
 *
 * - 動画: 内蔵ブラウザの webContents をタブ録画（chromeMediaSource: 'tab'）して MediaRecorder へ。
 *   画面全体・別のウインドウを選んだときは chromeMediaSource: 'desktop' で取り込む（要 画面収録の許可）。
 *   そのときの静止画は、main から頼まれるたびにこの映像から1枚切り出して返す。
 *   `timeslice` ごとの塊をそのまま main へ渡し、main がファイルへ追記する（NF-12）。
 * - 音声: マイク（自分）と PC音声（相手）を**別々の AudioContext** で受け、
 *   16kHz モノラルの Int16 PCM にして main へ送る。動画側のトラックとは分けるので、
 *   文字起こしの系統（話者）が混ざらない。
 *
 * AudioContext を 16000Hz で作ると、Chromium が入力を自動でリサンプルしてくれる。
 * 自前のリサンプラを持たずに済み、品質も安定する。
 */

import { init as initSentry } from '@sentry/electron/renderer'
import { classifySystemAudioError } from '../shared/systemAudio'

export {} // このファイルをモジュールにする（declare global のため）

/*
 * 録画ウインドウの例外もクラッシュレポートに載せる（src/main/telemetry.ts）。main が Sentry を初期化した起動だけ、
 * Sentry の preload が __SENTRY_IPC__ を置くので、それがあるときだけ初期化する。操作の記録（パンくず）は集めない
 */
if ((window as { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__) {
  initSentry({ integrations: (defaults) => defaults.filter((i) => i.name !== 'Breadcrumbs' && i.name !== 'HttpContext'), maxBreadcrumbs: 0 })
}

interface StartPayload {
  sourceKind: 'tab' | 'desktop'
  sourceId: string
  startedAtEpoch: number
  platform?: string
  captureMic: boolean
  syntheticMicWavBase64?: string
  syntheticMic: boolean
  captureSystemAudio: boolean
  systemAudioEndAfterMs?: number
  systemAudioSynthetic?: boolean
  /** 検証用（E2E の偽の画面・ウインドウ）。画面・ウインドウの代わりに canvas の映像を録る（OS の画面収録に触れない） */
  syntheticDesktop?: boolean
  micDeviceId?: string
  videoBitsPerSecond: number
  videoMaxWidth: number
  videoMaxFrameRate: number
  videoTimesliceMs: number
  /** タブの映像の上に、拡張機能のポップアップの映像を重ねてから録る（OverlayCompositor） */
  composite?: boolean
  /** エラーの文（画面の言語）。{{message}} / {{source}} をここで埋める。main（recorderWindow.ts）が渡す */
  messages?: Partial<Record<keyof typeof DEFAULT_MESSAGES, string>>
}

interface RecorderBridge {
  onStart(fn: (payload: StartPayload) => void): void
  onPause(fn: () => void): void
  onResume(fn: () => void): void
  onStop(fn: () => void): void
  video(chunk: ArrayBuffer): void
  pcm(block: { source: 'mic' | 'system'; offsetMs: number; samples: ArrayBuffer }): void
  level(level: { source: 'mic' | 'system'; rms: number; peak: number }): void
  error(message: string): void
  stopped(): void
  started(): void
  onGrab(fn: (id: number) => void): void
  frame(id: number, png: ArrayBuffer | null): void
  onOverlay(fn: (overlay: unknown) => void): void
}

/** Chromium の Insertable Streams（lib.dom に型が無い） */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<VideoFrame>
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' })
  readonly writable: WritableStream<VideoFrame>
}

/** Chromium の ImageCapture（lib.dom に型が無い） */
declare class ImageCapture {
  constructor(track: MediaStreamTrack)
  grabFrame(): Promise<ImageBitmap>
}

declare global {
  interface Window {
    adeRecorder: RecorderBridge
  }
}

const bridge = window.adeRecorder

/** 録画開始時に main から届く文。届く前・欠けたときは英語 */
let messages: NonNullable<StartPayload['messages']> = {}
const DEFAULT_MESSAGES = {
  videoEnded: 'The recorded screen or window was closed, so video and image capture stopped. Audio and drawings are still being recorded.',
  videoFailed: "Couldn't capture video: {{message}}",
  micFailed: "Couldn't access the microphone: {{message}}",
  systemAudioFailed: "Couldn't capture system audio: {{message}}",
  systemAudioDenied: "Couldn't record the other side because system audio access wasn't allowed. Your microphone is still being recorded.",
  systemAudioNoDevice: "Couldn't record the other side because no audio output device was found. Your microphone is still being recorded.",
  systemAudioEnded: 'System audio stopped (the output device may have changed). The rest of the recording continues without the other side.',
  noAudioTrack: '{{source}}: no audio track'
}
function text(key: keyof typeof DEFAULT_MESSAGES, params: Record<string, string> = {}): string {
  return (messages[key] ?? DEFAULT_MESSAGES[key]).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => params[name] ?? whole)
}
const SAMPLE_RATE = 16_000

/** 1系統ぶんの音声取り込み */
class AudioCapture {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private stream: MediaStream | null = null
  private samplesSent = 0
  private paused = false

  constructor(
    private readonly source: 'mic' | 'system',
    /** この系統が録り始めたのが録画開始から何ms後か */
    private readonly startOffsetMs: number
  ) {}

  async start(stream: MediaStream): Promise<void> {
    if (stream.getAudioTracks().length === 0) {
      throw new Error(text('noAudioTrack', { source: this.source }))
    }
    this.stream = stream
    // 16kHz で作ると Chromium が入力を自動でリサンプルする
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.context = context
    await context.audioWorklet.addModule('./pcm-worklet.js')

    const node = new AudioWorkletNode(context, 'ade-pcm', { numberOfOutputs: 0 })
    this.node = node
    node.port.onmessage = (event: MessageEvent) => {
      if (this.paused) return
      const data = event.data as { samples: Int16Array; rms: number; peak: number }
      const offsetMs = this.startOffsetMs + (this.samplesSent / SAMPLE_RATE) * 1000
      this.samplesSent += data.samples.length
      // 転送可能オブジェクトとして渡す（コピーを減らす）
      bridge.pcm({ source: this.source, offsetMs, samples: data.samples.buffer as ArrayBuffer })
      bridge.level({ source: this.source, rms: data.rms, peak: data.peak })
    }

    context.createMediaStreamSource(stream).connect(node)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  get sampleCount(): number {
    return this.samplesSent
  }

  stop(): void {
    this.node?.port.close()
    this.node?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.context = null
    this.node = null
    this.stream = null
  }
}

interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

/** main から届く重ねるもの。形が違えば null（重ねない） */
function readOverlay(raw: unknown): { sourceId: string; rect: OverlayRect } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { sourceId?: unknown; rect?: Partial<Record<keyof OverlayRect, unknown>> }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const rect = { x: n(r.rect?.x), y: n(r.rect?.y), width: n(r.rect?.width), height: n(r.rect?.height) }
  if (typeof r.sourceId !== 'string' || !r.sourceId || Object.values(rect).some(Number.isNaN) || rect.width <= 0 || rect.height <= 0) return null
  return { sourceId: r.sourceId, rect }
}

/**
 * タブの映像（内蔵ブラウザのビュー）の上に、拡張機能のポップアップ（別のビュー。タブ録画には写らない）の映像を重ねる。
 *
 * 両方の映像をフレームごとに受け（MediaStreamTrackProcessor）、OffscreenCanvas に重ねて描き、新しい映像（MediaStreamTrackGenerator）にする。
 * 画面に描かない（非表示の録画ウインドウでも止まらない）。どちらかの映像が変わったときだけ描き、フレームレートの上限で間引く
 */
class OverlayCompositor {
  readonly stream: MediaStream
  private readonly canvas = new OffscreenCanvas(2, 2)
  private readonly context = this.canvas.getContext('2d', { alpha: false })
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>
  private base: VideoFrame | null = null
  private top: VideoFrame | null = null
  private topTrack: MediaStreamTrack | null = null
  private topSource: string | null = null
  private rect: OverlayRect | null = null
  private generation = 0
  private lastDraw = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly minIntervalMs: number

  static supported(): boolean {
    return typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function'
  }

  constructor(baseTrack: MediaStreamTrack, private readonly maxFrameRate: number) {
    this.minIntervalMs = 1000 / Math.max(1, maxFrameRate)
    const generator = new MediaStreamTrackGenerator({ kind: 'video' })
    this.writer = generator.writable.getWriter()
    this.stream = new MediaStream([generator])
    void this.pump(baseTrack, (frame) => { this.base?.close(); this.base = frame })
  }

  /** その映像のフレームを受け続ける。止めた・映像が終わったら抜ける */
  private async pump(track: MediaStreamTrack, take: (frame: VideoFrame) => void, generation?: number): Promise<void> {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (this.stopped || (generation !== undefined && generation !== this.generation)) {
          value.close()
          break
        }
        take(value)
        this.schedule()
      }
    } catch {
      // 映像が途中で止まった（ポップアップが閉じた等）。重ねるのをやめるだけ（想定内）
    } finally {
      reader.releaseLock()
    }
  }

  /** ポップアップが開いた・動いた・閉じた（null） */
  async setOverlay(next: { sourceId: string; rect: OverlayRect } | null): Promise<void> {
    if (this.stopped) return
    if (next && next.sourceId === this.topSource) {
      this.rect = next.rect
      this.schedule()
      return
    }
    const generation = ++this.generation
    this.topTrack?.stop()
    this.topTrack = null
    this.top?.close()
    this.top = null
    this.topSource = next?.sourceId ?? null
    this.rect = next?.rect ?? null
    this.schedule()
    if (!next) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: next.sourceId, maxFrameRate: this.maxFrameRate } } as unknown as MediaTrackConstraints
      })
      const track = stream.getVideoTracks()[0] ?? null
      if (!track || this.stopped || generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return }
      this.topTrack = track
      void this.pump(track, (frame) => { this.top?.close(); this.top = frame }, generation)
    } catch (err) {
      // 重ねられなくても録画は続ける（タブの映像だけになる）
      console.warn('[recorder] overlay capture failed', message(err))
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) return
    const wait = this.lastDraw + this.minIntervalMs - performance.now()
    if (wait <= 0) return this.draw()
    this.timer = setTimeout(() => { this.timer = null; this.draw() }, wait)
  }

  private draw(): void {
    const base = this.base
    const context = this.context
    if (this.stopped || !base || !context) return
    this.lastDraw = performance.now()
    const width = base.displayWidth
    const height = base.displayHeight
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    context.drawImage(base, 0, 0, width, height)
    const rect = this.rect
    if (this.top && rect) {
      const x = Math.round(rect.x * width)
      const y = Math.round(rect.y * height)
      const w = Math.round(rect.width * width)
      const h = Math.round(rect.height * height)
      context.drawImage(this.top, x, y, w, h)
      // ポップアップの縁（ページと見分けられるよう、Chrome のポップアップと同じく薄い線）
      context.strokeStyle = 'rgba(0, 0, 0, 0.25)'
      context.lineWidth = 1
      context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
    }
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000) })
    this.writer.write(frame).catch(() => frame.close())
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.topTrack?.stop()
    this.base?.close()
    this.top?.close()
    this.base = this.top = null
    void this.writer.close().catch(() => undefined)
  }
}

let compositor: OverlayCompositor | null = null
/** 録画を始める前に届いた重ねるもの（開いていたポップアップ） */
let pendingOverlay: { sourceId: string; rect: OverlayRect } | null = null

let recorder: MediaRecorder | null = null
let videoTrack: MediaStreamTrack | null = null
const captures: AudioCapture[] = []
let videoWrites: Promise<void> = Promise.resolve()
/** 止める操作の途中。相手の声の取り込みが終わっても「途中で止まった」とは知らせない */
let stopping = false

/**
 * 映像。内蔵ブラウザのタブ映像（tab）は OSの画面収録権限が要らない。
 * 画面全体・別のウインドウ（desktop）は macOS で「画面収録」の許可が要る。
 *
 * 取り込みの時点で大きさとフレームレートを絞る。
 * Retina の原寸・30fps のままだと 90分で2GBを超え、見返しの役に立つ以上の容量を使う。
 */
async function captureVideo(
  sourceKind: 'tab' | 'desktop',
  sourceId: string,
  maxWidth: number,
  maxFrameRate: number
): Promise<MediaStream> {
  const mandatory: Record<string, unknown> = {
    // desktop は画面全体・別のウインドウ（desktopCapturer の ID）
    chromeMediaSource: sourceKind,
    chromeMediaSourceId: sourceId,
    maxFrameRate
  }
  if (maxWidth > 0) {
    mandatory.maxWidth = maxWidth
    // 縦は横から決める（16:10 より縦長の画面でも収まるよう余裕をみる）
    mandatory.maxHeight = Math.round(maxWidth * 1.2)
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    // Electron のタブ録画は旧来の constraints でしか指定できない
    video: { mandatory } as unknown as MediaTrackConstraints
  })
}

/**
 * 検証用（E2E の偽の画面・ウインドウ。main の fakeCapture.ts）。ID ごとに色の違う canvas を動かし続けた映像。
 * 非表示の窓でも描き続けるよう requestAnimationFrame ではなくタイマーで描く
 */
function syntheticDesktopStream(sourceId: string, maxFrameRate: number): MediaStream {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 400
  const ctx = canvas.getContext('2d')
  let hue = 0
  for (const ch of sourceId) hue = (hue * 31 + ch.charCodeAt(0)) % 360
  let n = 0
  const draw = () => {
    if (!ctx) return
    ctx.fillStyle = `hsl(${hue}, 70%, 45%)`
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect((n * 8) % canvas.width, 180, 40, 40)
    ctx.font = '24px sans-serif'
    ctx.fillText(sourceId, 20, 40)
    n++
  }
  draw()
  const timer = setInterval(draw, 100)
  const stream = canvas.captureStream(Math.max(1, Math.min(30, maxFrameRate)))
  stream.getVideoTracks()[0]?.addEventListener('ended', () => clearInterval(timer))
  return stream
}

/**
 * PC音声（相手の声。AUD-1）。
 * getDisplayMedia で取る。main（recorderWindow.ts）の setDisplayMediaRequestHandler が、映像はこのウインドウ自身、
 * 音声は PC のループバックを返す（macOS 14.2+ は Core Audio の tap、Windows は再生デバイス、Linux は PulseAudio のモニター）。
 * Windows で取れなかったときだけ、古い取り込み方（desktop の音声）を試す。取れない場合も録画は続ける（マイクだけになる）。
 */
async function captureSystemAudio(payload: StartPayload): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  } catch (err) {
    const kind = classifySystemAudioError(err instanceof Error ? err.name : undefined, payload.platform)
    if (payload.systemAudioSynthetic || payload.platform !== 'win32' || kind === 'denied') throw err
    return legacyDesktopAudio()
  }
}

/** Windows の古い取り込み方（chromeMediaSource: 'desktop' の音声） */
async function legacyDesktopAudio(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'desktop' }
    } as unknown as MediaTrackConstraints,
    video: {
      mandatory: { chromeMediaSource: 'desktop', maxWidth: 2, maxHeight: 2, maxFrameRate: 1 }
    } as unknown as MediaTrackConstraints
  })
}

async function start(payload: StartPayload): Promise<void> {
  const startedAt = payload.startedAtEpoch
  stopping = false
  messages = payload.messages ?? {}

  // 映像
  try {
    const stream = payload.syntheticDesktop && payload.sourceKind === 'desktop'
      ? syntheticDesktopStream(payload.sourceId, payload.videoMaxFrameRate)
      : await captureVideo(
        payload.sourceKind,
        payload.sourceId,
        payload.videoMaxWidth,
        payload.videoMaxFrameRate
      )
    videoTrack = stream.getVideoTracks()[0] ?? null
    if (videoTrack && payload.sourceKind === 'desktop') {
      // 録っていたウインドウが閉じられた。音声と書き込みの記録は続ける
      videoTrack.onended = () => bridge.error(text('videoEnded'))
    }
    // 拡張機能のポップアップも録るときは、タブの映像に重ねた映像を録る（使えない環境ではタブの映像のまま）
    let recorded = stream
    if (payload.composite && payload.sourceKind === 'tab' && videoTrack && OverlayCompositor.supported()) {
      compositor = new OverlayCompositor(videoTrack, payload.videoMaxFrameRate)
      recorded = compositor.stream
      if (pendingOverlay) void compositor.setOverlay(pendingOverlay)
    } else if (payload.composite) console.warn('[recorder] overlay compositing is not available; recording the page only')
    recorder = new MediaRecorder(recorded, {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: payload.videoBitsPerSecond
    })
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      videoWrites = videoWrites.then(async () => bridge.video(await event.data.arrayBuffer()))
    }
    recorder.onerror = (event) => bridge.error(`MediaRecorder: ${String((event as ErrorEvent).error)}`)
    recorder.start(payload.videoTimesliceMs)
  } catch (err) {
    bridge.error(text('videoFailed', { message: message(err) }))
  }

  // マイク（自分）
  if (payload.captureMic) {
    try {
      const stream = payload.syntheticMic
        ? await syntheticSpeechStream(payload.syntheticMicWavBase64)
        : await navigator.mediaDevices.getUserMedia({
            /*
             * 相手の声も録るときは、スピーカーから出た相手の声がマイクに入りにくいようエコー除去を入れる。
             * 残った二重取りは、文字起こしのあとに時刻と文で落とす（src/main/pipeline/merge.ts）
             */
            audio: payload.micDeviceId
              ? {
                  deviceId: { exact: payload.micDeviceId },
                  echoCancellation: payload.captureSystemAudio,
                  noiseSuppression: false
                }
              : { echoCancellation: payload.captureSystemAudio, noiseSuppression: false },
            video: false
          })
      const capture = new AudioCapture('mic', Date.now() - startedAt)
      await capture.start(stream)
      captures.push(capture)
    } catch (err) {
      bridge.error(text('micFailed', { message: message(err) }))
    }
  }

  // PC音声（相手。MTG時のみ）
  if (payload.captureSystemAudio) {
    try {
      const stream = await captureSystemAudio(payload)
      // 映像トラックは不要なので止める（音声だけ使う）
      stream.getVideoTracks().forEach((track) => track.stop())
      const track = stream.getAudioTracks()[0]
      // 音声の出力先が無いと、音声の無い取り込みが返る
      if (!track) throw new DOMException('no system audio track', 'NotFoundError')
      // 出力先が抜かれた・切り替わった。マイクと映像は続ける
      track.addEventListener('ended', () => { if (!stopping) bridge.error(text('systemAudioEnded')) })
      const capture = new AudioCapture('system', Date.now() - startedAt)
      await capture.start(stream)
      captures.push(capture)
      if (payload.systemAudioEndAfterMs) {
        // 検証用: 取り込みが途中で止まったときと同じにする（stop() では ended が来ないので自分で送る）
        setTimeout(() => { track.stop(); track.dispatchEvent(new Event('ended')) }, payload.systemAudioEndAfterMs)
      }
    } catch (err) {
      const kind = classifySystemAudioError(err instanceof Error ? err.name : undefined, payload.platform)
      bridge.error(kind === 'denied' ? text('systemAudioDenied') : kind === 'noDevice' ? text('systemAudioNoDevice') : text('systemAudioFailed', { message: message(err) }))
    }
  }
  bridge.started()
}

/**
 * 検証用の合成音声。実機のマイクを開かずに、音声の経路（Worklet → PCM → main）を通す。
 * 1.2秒鳴って0.8秒黙る、を繰り返す。無音区切り（SilenceSegmenter）の確認にも使える。
 */
async function syntheticSpeechStream(wavBase64?: string): Promise<MediaStream> {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  if (wavBase64) {
    const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
    const source = context.createBufferSource()
    source.buffer = await context.decodeAudioData(bytes.buffer)
    source.connect(destination)
    source.start(context.currentTime + 0.35)
    return destination.stream
  }
  const oscillator = context.createOscillator()
  oscillator.type = 'sawtooth'
  oscillator.frequency.value = 180
  const gain = context.createGain()
  gain.gain.value = 0
  oscillator.connect(gain).connect(destination)
  oscillator.start()
  const begin = context.currentTime
  for (let i = 0; i < 300; i++) {
    const at = begin + i * 2
    gain.gain.setValueAtTime(0.25, at)
    gain.gain.setValueAtTime(0, at + 1.2)
  }
  return destination.stream
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * いまの映像を1枚 PNG にする（画面全体・別のウインドウの静止画）。
 * 録画の映像トラックをそのまま使うので、画面収録の許可を二重に求めない。
 */
async function grabFrame(): Promise<ArrayBuffer | null> {
  const track = videoTrack
  if (!track || track.readyState !== 'live' || typeof ImageCapture === 'undefined') return null
  const bitmap = await new ImageCapture(track).grabFrame()
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return await blob.arrayBuffer()
  } finally {
    bitmap.close()
  }
}

bridge.onGrab((id) => {
  grabFrame()
    .then((png) => bridge.frame(id, png))
    .catch(() => bridge.frame(id, null))
})

bridge.onOverlay((raw) => {
  pendingOverlay = readOverlay(raw)
  void compositor?.setOverlay(pendingOverlay)
})

bridge.onStart((payload: StartPayload) => {
  void start(payload).catch((err) => bridge.error(message(err)))
})

bridge.onPause(() => {
  if (recorder?.state === 'recording') recorder.pause()
  for (const capture of captures) capture.setPaused(true)
})

bridge.onResume(() => {
  if (recorder?.state === 'paused') recorder.resume()
  for (const capture of captures) capture.setPaused(false)
})

bridge.onStop(() => {
  stopping = true
  const done = async (): Promise<void> => {
    videoTrack?.stop()
    compositor?.stop()
    compositor = null
    pendingOverlay = null
    for (const capture of captures) capture.stop()
    captures.length = 0
    await videoWrites
    bridge.stopped()
  }
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = done
    // 残っている分を吐き出させてから止める
    recorder.requestData()
    recorder.stop()
  } else {
    done()
  }
})
