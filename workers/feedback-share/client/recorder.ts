/**
 * 相手の画面の録画（ブラウザの MediaRecorder）。
 *
 * - live（Chrome・Edge）: getDisplayMedia の preferCurrentTab で「このタブ」を録り、Region Capture（CropTarget）で
 *   ページと書き込みの面（stage）だけに切り抜く。iframe のページが別オリジンでも映る。使えなければ声と書き込みだけ
 * - screen: getDisplayMedia で選んだタブ・ウインドウ・画面を録る。書き込みは手元の面に重ねて描き、canvas で合成して録る
 * - 声はマイク（getUserMedia）。使えなければ声なしで録る
 * 時計は一時停止の間を数えない（書き込みの記録と録画の時刻をそろえる）。上限（10分・300MB）に達したら止める
 */
import { SHARE_LIMITS, type ShareMediaType } from '../../../src/shared/feedbackShare'

type CropTargetCtor = { fromElement(element: Element): Promise<unknown> }
type CroppableTrack = MediaStreamTrack & { cropTo?: (target: unknown) => Promise<void> }

/** 画面の切り抜き（Region Capture）が使えるか */
export function canCropTab(): boolean {
  return typeof (globalThis as { CropTarget?: CropTargetCtor }).CropTarget?.fromElement === 'function' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

export function canShareScreen(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined'
}

/** 録画の時計（一時停止の間は進まない） */
export class RecClock {
  private startedAt = 0
  private pausedAt: number | null = null
  private pausedTotal = 0
  start(): void {
    this.startedAt = performance.now()
    this.pausedAt = null
    this.pausedTotal = 0
  }
  pause(): void {
    if (this.pausedAt === null) this.pausedAt = performance.now()
  }
  resume(): void {
    if (this.pausedAt !== null) this.pausedTotal += performance.now() - this.pausedAt
    this.pausedAt = null
  }
  now(): number {
    const end = this.pausedAt ?? performance.now()
    return Math.max(0, Math.round(end - this.startedAt - this.pausedTotal))
  }
}

const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

function pickType(video: boolean): string | null {
  for (const type of video ? VIDEO_TYPES : AUDIO_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return null
}

/** 送るときの形式（パラメータを落とす） */
export function baseMime(type: string, video: boolean): ShareMediaType {
  const base = type.split(';')[0]!.trim()
  if (base === 'video/mp4' || base === 'audio/mp4') return video ? 'video/mp4' : 'audio/mp4'
  return video ? 'video/webm' : 'audio/webm'
}

export interface Sources {
  display: MediaStream | null
  mic: MediaStream | null
  warnings: Array<'micDenied' | 'captureDenied'>
}

/** マイク。使えなければ null（声なしで録る） */
export async function openMic(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch {
    return null
  }
}

/** このタブを録り、stage の部分だけに切り抜く。使えない・断られたら null */
export async function openCroppedTab(stage: Element): Promise<MediaStream | null> {
  if (!canCropTab()) return null
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15, displaySurface: 'browser' }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude'
    } as DisplayMediaStreamOptions)
    const track = stream.getVideoTracks()[0] as CroppableTrack | undefined
    const target = await (globalThis as unknown as { CropTarget: CropTargetCtor }).CropTarget.fromElement(stage)
    if (!track?.cropTo) throw new Error('crop unsupported')
    await track.cropTo(target)
    return stream
  } catch {
    stream?.getTracks().forEach((t) => t.stop())
    return null
  }
}

/** 画面共有（タブ・ウインドウ・画面）。断られたら null */
export async function openScreen(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false, selfBrowserSurface: 'exclude' } as DisplayMediaStreamOptions)
  } catch {
    return null
  }
}

/** マイクの入力レベル（0..1 の RMS） */
export class MicMeter {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private data: Float32Array<ArrayBuffer> | null = null
  constructor(stream: MediaStream | null) {
    if (!stream || typeof AudioContext === 'undefined') return
    try {
      this.ctx = new AudioContext()
      const source = this.ctx.createMediaStreamSource(stream)
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      source.connect(this.analyser)
      this.data = new Float32Array(this.analyser.fftSize)
    } catch {
      this.ctx = null
    }
  }
  level(): number {
    if (!this.analyser || !this.data) return 0
    this.analyser.getFloatTimeDomainData(this.data)
    let sum = 0
    for (const v of this.data) sum += v * v
    return Math.sqrt(sum / this.data.length)
  }
  close(): void {
    void this.ctx?.close().catch(() => undefined)
  }
}

export interface RecordingResult {
  blob: Blob | null
  mime: ShareMediaType | null
  hasVideo: boolean
  durationMs: number
}

/**
 * 録画1本。video は録る映像（無ければ声だけ）、mic は声（無ければ映像だけ）。どちらも無ければ媒体なし（文字の指摘だけ）
 */
export class ShareRecorder {
  readonly clock = new RecClock()
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private bytes = 0
  private type: string | null = null
  private stopped: Promise<void> | null = null
  private limitTimer: number | null = null
  /** 上限に達して止めた */
  onLimit: (() => void) | null = null

  constructor(private readonly video: MediaStream | null, private readonly mic: MediaStream | null) {}

  get hasVideo(): boolean {
    return !!this.video && this.type !== null && this.type.startsWith('video/')
  }

  start(): void {
    this.clock.start()
    const tracks = [...(this.video?.getVideoTracks() ?? []), ...(this.mic?.getAudioTracks() ?? [])]
    if (tracks.length === 0 || !canRecord()) return
    const type = pickType(!!this.video?.getVideoTracks().length)
    if (!type) return
    this.type = type
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 64_000 })
    this.recorder = recorder
    this.stopped = new Promise((done) => recorder.addEventListener('stop', () => done(), { once: true }))
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return
      this.chunks.push(event.data)
      this.bytes += event.data.size
      if (this.bytes >= SHARE_LIMITS.recordingBytes - 2 * 1024 * 1024) this.hitLimit()
    })
    recorder.start(1000)
    this.limitTimer = window.setInterval(() => {
      if (this.clock.now() >= SHARE_LIMITS.recordingMs) this.hitLimit()
    }, 500)
  }

  private hitLimit(): void {
    if (this.recorder?.state === 'recording' || this.recorder?.state === 'paused') {
      this.recorder.stop()
      this.onLimit?.()
    }
  }

  pause(): void {
    this.clock.pause()
    if (this.recorder?.state === 'recording') this.recorder.pause()
  }

  resume(): void {
    this.clock.resume()
    if (this.recorder?.state === 'paused') this.recorder.resume()
  }

  async stop(): Promise<RecordingResult> {
    const durationMs = Math.min(this.clock.now(), SHARE_LIMITS.recordingMs)
    if (this.limitTimer !== null) window.clearInterval(this.limitTimer)
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    await this.stopped
    const hasVideo = this.hasVideo
    const blob = this.type && this.chunks.length ? new Blob(this.chunks, { type: this.type.split(';')[0] }) : null
    return { blob, mime: blob && this.type ? baseMime(this.type, hasVideo) : null, hasVideo: hasVideo && !!blob, durationMs }
  }
}

/** 映像の1コマを JPEG（base64）にする。幅は width まで縮める。撮れなければ undefined */
export function frameToJpeg(source: CanvasImageSource & { videoWidth?: number; videoHeight?: number; width?: number; height?: number }, width = 480): string | undefined {
  const sw = source.videoWidth ?? (source.width as number) ?? 0
  const sh = source.videoHeight ?? (source.height as number) ?? 0
  if (!sw || !sh) return undefined
  const scale = Math.min(1, width / sw)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw * scale)
  canvas.height = Math.round(sh * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', 0.75)
    const data = url.slice(url.indexOf(',') + 1)
    return data.length * 0.75 <= SHARE_LIMITS.thumbnailBytes ? data : undefined
  } catch {
    return undefined
  }
}
