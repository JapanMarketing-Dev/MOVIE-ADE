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
  captureMic: boolean
  syntheticMicWavBase64?: string
  syntheticMic: boolean
  captureSystemAudio: boolean
  micDeviceId?: string
  videoBitsPerSecond: number
  videoMaxWidth: number
  videoMaxFrameRate: number
  videoTimesliceMs: number
  /** エラーの文（画面の言語）。{{message}} / {{source}} をここで埋める。main（recorderWindow.ts）が渡す */
  messages?: Partial<Record<'videoEnded' | 'videoFailed' | 'micFailed' | 'systemAudioFailed' | 'noAudioTrack', string>>
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

let recorder: MediaRecorder | null = null
let videoTrack: MediaStreamTrack | null = null
const captures: AudioCapture[] = []
let videoWrites: Promise<void> = Promise.resolve()

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
 * PC音声（相手の声。AUD-1）。
 * Electron では「画面共有の音声ループバック」として取る。
 * macOS 13未満では取れない。取れない場合も録画は続ける（マイクだけになる）。
 */
async function captureSystemAudio(): Promise<MediaStream> {
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
  messages = payload.messages ?? {}

  // 映像
  try {
    const stream = await captureVideo(
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
    recorder = new MediaRecorder(stream, {
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
            audio: payload.micDeviceId
              ? {
                  deviceId: { exact: payload.micDeviceId },
                  echoCancellation: false,
                  noiseSuppression: false
                }
              : { echoCancellation: false, noiseSuppression: false },
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
      const stream = await captureSystemAudio()
      // 映像トラックは不要なので止める（音声だけ使う）
      stream.getVideoTracks().forEach((track) => track.stop())
      const capture = new AudioCapture('system', Date.now() - startedAt)
      await capture.start(stream)
      captures.push(capture)
    } catch (err) {
      bridge.error(text('systemAudioFailed', { message: message(err) }))
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
  const done = async (): Promise<void> => {
    videoTrack?.stop()
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
