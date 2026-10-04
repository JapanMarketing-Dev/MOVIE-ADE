/**
 * 録画中の文字起こしの途中経過を画面へ送る（右パネルの「文字起こし」タブと、止まったときの警告）。
 *
 * 文字起こしそのものは IncrementalTranscriber（engine.ts）が録画中に区切りごと順に行っている。
 * ここはその進み具合（待ち・済み・失敗）とマイクのレベルから状態を作り、変わったときだけ送る。
 * 送り先は差し込む（Electron に依存しない。単体テストできる）。
 */
import {
  IDLE_LIVE_STATUS, LIVE_BATCH_MAX, SpeechStallWatch, sanitizeLiveSegment,
  type LiveTranscriptBatch, type LiveTranscriptSegment, type LiveTranscriptStatus
} from '@shared/liveTranscript'
import type { TranscriptSegment } from '../types'
import type { TranscriberProgress } from './engine'

export interface LiveFeedSink {
  status(status: LiveTranscriptStatus): void
  segments(batch: LiveTranscriptBatch): void
}

export interface LiveFeedStart {
  /** 文字起こしが動いているか（モデル・キーがあり、エンジンを作れた） */
  transcribing: boolean
  /** 音を録るか（マイクか PC の音声） */
  audio: boolean
  /** マイクを録るか（マイクの無音の見張りに使う） */
  mic: boolean
  twoSpeakers: boolean
  /** 動いていない理由（設定の不足など。録画の警告と同じ文） */
  message?: string
}

export class LiveTranscriptFeed {
  private status: LiveTranscriptStatus = { ...IDLE_LIVE_STATUS }
  private watch: SpeechStallWatch | null = null
  private mic = false

  constructor(private readonly sink: LiveFeedSink, private readonly makeWatch: () => SpeechStallWatch = () => new SpeechStallWatch()) {}

  current(): LiveTranscriptStatus { return { ...this.status } }

  /** 録画を始めた。前の録画の文字は画面が run の変化で捨てる */
  start(options: LiveFeedStart): void {
    this.mic = options.mic
    this.watch = options.transcribing ? this.makeWatch() : null
    this.status = {
      run: this.status.run + 1, active: true,
      state: !options.audio ? 'off' : options.transcribing ? 'idle' : options.message ? 'unavailable' : 'off',
      pending: 0, done: 0, failed: 0, twoSpeakers: options.twoSpeakers,
      ...(options.transcribing || !options.message ? {} : { message: options.message })
    }
    this.emit()
  }

  /** 文字起こしの進み具合（IncrementalTranscriber の onProgress） */
  progress(p: TranscriberProgress): void {
    if (!this.status.active) return
    const next: LiveTranscriptStatus = { ...this.status, pending: p.pending }
    const finished = p.segments !== undefined || p.error !== undefined
    if (p.error) {
      next.failed++
      next.state = 'error'
      next.message = p.error.message
    } else if (finished) {
      next.done++
      next.state = p.pending > 0 ? 'working' : 'idle'
      delete next.message
    } else if (next.state !== 'error') next.state = p.pending > 0 ? 'working' : 'idle'
    if (p.segments?.length) {
      const segments = p.segments.map(toLive).filter((s): s is LiveTranscriptSegment => s !== null)
      for (let i = 0; i < segments.length; i += LIVE_BATCH_MAX) this.sink.segments({ run: next.run, segments: segments.slice(i, i + LIVE_BATCH_MAX) })
      if (segments.length) this.watch?.text()
    }
    this.watch?.check(next.pending)
    this.status = this.withWarning(next)
    this.emit()
  }

  /** マイク・PC 音声のレベル（100ms ごと）。警告が変わったときだけ送る */
  level(source: 'mic' | 'system', rms: number, peak: number): void {
    if (!this.status.active || !this.watch || source !== 'mic' || !this.mic) return
    const changed = this.watch.level(rms, peak)
    const checked = this.watch.check(this.status.pending)
    if (!changed && !checked) return
    this.status = this.withWarning({ ...this.status })
    this.emit()
  }

  /** 録画を止め、残りの文字起こしが済んだ */
  stop(): void {
    if (!this.status.active) return
    this.watch = null
    const { warning: _warning, ...rest } = this.status
    this.status = { ...rest, active: false, pending: 0, state: rest.state === 'working' ? 'idle' : rest.state }
    this.emit()
  }

  private withWarning(status: LiveTranscriptStatus): LiveTranscriptStatus {
    const warning = this.watch?.warning()
    const { warning: _old, ...rest } = status
    return warning ? { ...rest, warning } : rest
  }

  private emit(): void {
    this.sink.status({ ...this.status })
  }
}

function toLive(segment: TranscriptSegment): LiveTranscriptSegment | null {
  return sanitizeLiveSegment({ t0: segment.t0, t1: segment.t1, text: segment.text, source: segment.source === 'system' || segment.speaker === 'other' ? 'system' : 'mic' })
}
