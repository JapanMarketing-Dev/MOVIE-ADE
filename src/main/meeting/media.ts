/**
 * 取り込んだ mtg の動画・音声から、長さ・コマ（静止画）・音声（16kHz モノラル）を取り出す。
 *
 * ffmpeg は配布物に入っていないので使わない（trimVideo.ts と同じ理由）。非表示のウィンドウで Chromium に再生・復号させる:
 *   - コマ: <video> をその時刻へ送り、canvas に描いて JPEG にする
 *   - 音声: ファイルを読み、OfflineAudioContext（16kHz）で復号してモノラルの 16bit にする
 * ページと動画は同じ ade-media（index.ts）に置く（出どころが違うと canvas が汚れて読めない）。
 * ページの処理は素の JS の文字列で送る（ビルドの変換で補助関数が混ざらないように）。
 */
import { BrowserWindow } from 'electron'

/** 非表示ウィンドウのページ（index.ts の ade-media が返す） */
const MEETING_HOST_URL = 'ade-media://review/meeting-host'
export const MEETING_HOST_HTML = '<!doctype html><meta charset="utf-8"><title>meeting</title>'

/** 音声を取り出せる長さの上限（復号した音声をメモリに持つため。これより長ければ文字起こしのファイルを使ってもらう） */
export const MAX_AUDIO_DECODE_MS = 3 * 60 * 60 * 1000
/** 音声を取り出せるファイルの大きさの上限（ページが丸ごと読むため） */
export const MAX_AUDIO_DECODE_BYTES = 2 * 1024 * 1024 * 1024
/** ページから一度に受け取る音声の大きさ（サンプル数。base64 にする前は2倍のバイト数） */
const PULL_SAMPLES = 16_000 * 60

export interface MeetingMediaInfo {
  durationMs: number
  /** 映像がある（コマを撮れる） */
  hasVideo: boolean
  width: number
  height: number
}

export class MeetingMedia {
  private window: BrowserWindow | null = null

  constructor(private readonly src: string) {}

  private async page(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
    })
    // 再生の音はスピーカーへ出さない
    window.webContents.setAudioMuted(true)
    await window.loadURL(MEETING_HOST_URL)
    this.window = window
    return window
  }

  private async run<T>(script: string, timeoutMs: number): Promise<T> {
    const window = await this.page()
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        window.webContents.executeJavaScript(script, true) as Promise<T>,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('meeting media timed out')), timeoutMs) })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 長さと映像の有無 */
  async probe(): Promise<MeetingMediaInfo> {
    const info = await this.run<{ duration: number; width: number; height: number }>(`(${OPEN_SCRIPT})(${JSON.stringify(this.src)})`, 60_000)
    return { durationMs: Math.max(0, Math.round(info.duration * 1000)), hasVideo: info.width > 0 && info.height > 0, width: info.width, height: info.height }
  }

  /** その時刻のコマ（JPEG のバイト列と大きさ）。撮れなければ null */
  async frame(tMs: number, maxWidth = 1280): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
    const shot = await this.run<{ data: string; width: number; height: number } | null>(`window.__meetingFrame(${Number(tMs) / 1000}, ${Number(maxWidth)})`, 20_000).catch(() => null)
    if (!shot?.data) return null
    return { jpeg: Buffer.from(shot.data, 'base64'), width: shot.width, height: shot.height }
  }

  /**
   * 音声を 16kHz モノラルの 16bit にして、1分ずつ onPcm へ渡す（時刻順）。
   * 長すぎる・大きすぎるときは投げる（呼び出し側が利用者向けの文にする）
   */
  async decodeAudio(onPcm: (pcm: Int16Array) => void | Promise<void>, onProgress?: (done: number, total: number) => void): Promise<void> {
    const total = await this.run<number>(`(${AUDIO_SCRIPT})(${JSON.stringify(this.src)}, ${MAX_AUDIO_DECODE_BYTES})`, 15 * 60_000)
    if (!Number.isFinite(total) || total <= 0) throw new Error('no audio')
    for (let at = 0; at < total; at += PULL_SAMPLES) {
      const base64 = await this.run<string>(`window.__meetingPull(${at}, ${Math.min(total, at + PULL_SAMPLES)})`, 60_000)
      const bytes = Buffer.from(base64, 'base64')
      await onPcm(new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2)))
      onProgress?.(Math.min(total, at + PULL_SAMPLES), total)
    }
    await this.run('void (window.__meetingPcm = null)', 10_000).catch(() => undefined)
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }
}

/**
 * 動画を開いて長さと大きさを返す。長さの無い webm（MediaRecorder で録ったもの）は、終わりへ送って長さを出させる。
 * あわせて、コマを撮る関数（window.__meetingFrame）を置く
 */
const OPEN_SCRIPT = `async function (src) {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = src
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('media error ' + (video.error ? video.error.code : '')))
  })
  if (!Number.isFinite(video.duration)) {
    await new Promise((resolve) => {
      const done = () => { video.removeEventListener('durationchange', check); resolve() }
      const check = () => { if (Number.isFinite(video.duration)) done() }
      video.addEventListener('durationchange', check)
      video.currentTime = 1e9
      setTimeout(done, 10000)
    })
    video.currentTime = 0
  }
  const canvas = document.createElement('canvas')
  window.__meetingFrame = async (t, maxWidth) => {
    if (!video.videoWidth) return null
    const at = Math.max(0, Math.min(t, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : t))
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000)
      video.onseeked = () => { clearTimeout(timer); resolve() }
      video.currentTime = at
    })
    const scale = Math.min(1, maxWidth / video.videoWidth)
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', 0.85)
    return { data: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height }
  }
  return { duration: Number.isFinite(video.duration) ? video.duration : 0, width: video.videoWidth, height: video.videoHeight }
}`

/** 音声を読み、16kHz モノラルの 16bit にして window.__meetingPcm に置く。サンプル数を返す。window.__meetingPull で少しずつ渡す */
const AUDIO_SCRIPT = `async function (src, maxBytes) {
  const res = await fetch(src)
  const length = Number(res.headers.get('content-length') || '0')
  if (length > maxBytes) throw new Error('too large')
  const data = await res.arrayBuffer()
  const context = new OfflineAudioContext(1, 1, 16000)
  const audio = await context.decodeAudioData(data)
  const channels = []
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c))
  const out = new Int16Array(audio.length)
  for (let i = 0; i < audio.length; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]
    const v = Math.max(-1, Math.min(1, sum / channels.length))
    out[i] = v < 0 ? v * 32768 : v * 32767
  }
  window.__meetingPcm = out
  window.__meetingPull = (start, end) => {
    const part = new Uint8Array(out.buffer, start * 2, (end - start) * 2)
    let binary = ''
    for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000))
    return btoa(binary)
  }
  return out.length
}`
