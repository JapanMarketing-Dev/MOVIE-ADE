/**
 * 録画エンジンの型（要件 5.3・5.4 / 設計 4章）。
 *
 * 時刻はすべて「録画開始からのミリ秒」。pipeline/types.ts の Event・FrameRef と
 * 同じ時計で、録画側はそちらの型に合わせて出力する。
 */

import type { CaptureTarget } from '@shared/types'
import type { Event, FrameRef } from '../pipeline/types'

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopping'

/** 音声の取得系統。pipeline の AudioSource と同じ値 */
export type AudioSourceKind = 'mic' | 'system'

export interface RecordingPaths {
  /** 動画（WebM）。逐次追記する */
  videoPath: string
  /** 静止画の置き場所 */
  framesDir: string
  /** 操作ログ（JSON Lines）。追記のみ */
  eventsPath: string
  /** 生PCMの置き場所（復旧用。NF-12） */
  audioDir: string
}

export interface RecordingOptions {
  paths: RecordingPaths
  /**
   * 録る対象。既定は内蔵ブラウザ（タブ録画。OSの許可は要らない）。
   * 画面全体・別のウインドウのときは、映像も静止画もその対象から取り、
   * 内蔵ブラウザ専用の情報（遷移・クリック・スクロール・要素情報）は記録しない。
   */
  captureTarget: CaptureTarget
  /** 自分の声（マイク）を録る。既定 true。切ると映像と操作ログだけになる */
  captureMic: boolean
  /** 相手の声も録る（AUD-1）。macOS では画面共有の音声ループバックを使う */
  captureSystemAudio: boolean
  /**
   * 検証用。マイクの代わりに合成音を使う。
   * 実機のマイクを開かないので、OSの権限ダイアログが出ない。本番は常に false。
   */
  syntheticMicWavBase64?: string
  syntheticMic?: boolean
  /** マイクの入力デバイス。未指定なら既定 */
  micDeviceId?: string
  /** 静止画の撮影間隔(ms)。既定 500（設計4章） */
  stillIntervalMs: number
  /** 静止画の保存形式。jpeg は容量が小さく、文字も読める */
  stillFormat: 'jpeg' | 'png'
  /** jpeg のときの品質(1-100) */
  stillQuality: number
  /**
   * 保存する静止画の長辺の上限(px)。0 なら原寸のまま。
   * Retina の原寸は1枚100KB超になり、90分で1GBを超える。
   * 最終出力は長辺1568pxへ縮めるので（設計5章④）、作業用もその少し上で足りる。
   */
  stillMaxWidth: number
  /**
   * 動画のビットレート(bps)。
   * 動画は人が見返すためだけのもので、指摘の画像は静止画から取る（設計4章）。
   * 90分で1GBを超えないよう絞る。
   */
  videoBitsPerSecond: number
  /**
   * 動画の長辺の上限(px)。0 なら原寸。
   * Retina の原寸（3024px）はビットレートを食うわりに見返しの役に立たない。
   */
  videoMaxWidth: number
  /** 動画のフレームレートの上限(fps)。画面の見返しに30fpsは要らない */
  videoMaxFrameRate: number
  /** MediaRecorder が1チャンクを吐く間隔(ms)。短いほど異常終了時の取りこぼしが減る */
  videoTimesliceMs: number
  /** 上限時間(ms)。既定 90分（REC-6） */
  maxDurationMs: number
  /**
   * 線・テキストを消す指示が来ないまま残り続ける上限(ms)。0 で保険なし。
   * 通常は発話の区切りで `clearAnnotations()` が呼ばれて消える。
   */
  annotationMaxHoldMs: number
}

export const defaultRecordingOptions: Omit<RecordingOptions, 'paths'> = {
  captureTarget: { kind: 'browser' },
  captureMic: true,
  captureSystemAudio: false,
  stillIntervalMs: 500,
  stillFormat: 'jpeg',
  stillQuality: 82,
  stillMaxWidth: 1600,
  videoBitsPerSecond: 1_200_000,
  videoMaxWidth: 1600,
  videoMaxFrameRate: 10,
  videoTimesliceMs: 1000,
  maxDurationMs: 90 * 60 * 1000,
  annotationMaxHoldMs: 30_000
}

/** 画面に出す録画の状態（REC-5） */
export interface RecordingStatus {
  state: RecordingState
  /** 一時停止ぶんを除いた経過時間(ms) */
  elapsedMs: number
  /** 書き出した動画のバイト数 */
  videoBytes: number
  /** 保存した静止画の枚数 */
  frameCount: number
  /** 記録した操作ログの件数 */
  eventCount: number
}

/** 入力レベル（REC-3 のレベル表示用）。0〜1 */
export interface AudioLevel {
  source: AudioSourceKind
  rms: number
  peak: number
}

/** 録画用ウィンドウから main へ届く PCM。16kHz モノラル Int16 */
export interface PcmBlock {
  source: AudioSourceKind
  /** この塊の先頭が録画開始から何ms後か（サンプル数から求めた値） */
  offsetMs: number
  samples: Int16Array
}

export interface RecordingResult {
  startedAt: string
  durationMs: number
  videoPath: string
  videoBytes: number
  frames: FrameRef[]
  events: Event[]
  /** 系統ごとの総サンプル数（16kHz） */
  audioSamples: Record<AudioSourceKind, number>
  /** 途中で起きた不具合（録画は続行している） */
  warnings: string[]
}

/** 録画側が外へ出すイベント */
export interface RecordingHandlers {
  onLimit?(): Promise<void>
  onStatus?(status: RecordingStatus): void
  onLevel?(level: AudioLevel): void
  /** 16kHz モノラルPCM。pipeline の SilenceSegmenter へそのまま流す */
  onPcm?(block: PcmBlock): void
  /** 操作ログ1件。sessions の appendEvents へ流す */
  onEvent?(event: Event): void
  /** 静止画1枚 */
  onFrame?(frame: FrameRef): void
  onWarning?(message: string): void
}
