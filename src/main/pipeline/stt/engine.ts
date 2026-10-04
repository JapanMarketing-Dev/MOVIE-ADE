/**
 * ① 文字起こしの実行方法のインタフェース。
 * ローカル（whisper.cpp）と OpenAI の STT API を差し替えられるようにする。
 * どの実装も同じ `{t0, t1, speaker, text}` を返す。
 */
import type { AudioSource, Speaker, TranscriptSegment } from '../types'
import { dropHallucinations, segmentDbfs } from './hallucination'
import { readWavPcm } from './wav'

export interface TranscribeChunkInput {
  /** 16kHz モノラル WAV のパス */
  wavPath: string;
  /** この WAV の先頭が録画開始から何ms後か */
  offsetMs: number;
  /** この系統の話者（マイク=self、PC音声=other） */
  speaker: Speaker
  source: AudioSource;
  /**
   * このチャンクの長さ(ms)。
   * 時刻を返さないモデル（gpt-transcribe）では、チャンク全体を1区間として扱うために使う。
   * 省略時は WAV ヘッダから求める。
   */
  durationMs?: number
}

export interface TranscribeResult {
  segments: TranscriptSegment[];
  /** 実行にかかった時間(ms)。計測用 */
  elapsedMs: number;
  /** 実行した内容（コマンドライン or エンドポイントとモデル）。記録・調査用 */
  commandLine: string;
  /** 課金の根拠になる音声の長さ(秒)。API が返した値があればそれ */
  billedSeconds?: number
}

/** 文字起こしの API が失敗の状態を返した。接続の確認で状態コードから理由を言い分けるのに使う */
export class SttHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message)
    this.name = 'SttHttpError'
  }
}

export interface SttEngine {
  /** 設定・ログで使う識別子 */
  readonly id: string;
  /** 使える状態か（バイナリ・モデルの有無、APIキーの有無） */
  available(): Promise<boolean>;
  /** 音声が端末外へ出るか（NF-2 の判断とUIの警告に使う） */
  readonly sendsAudioOffDevice: boolean
  transcribeChunk(input: TranscribeChunkInput): Promise<TranscribeResult>
}

/**
 * 録画中の逐次実行をまとめる。区切りを push すると順番に処理し、済んだ分を保持する。
 * 停止時は flush() で残りを待つだけでよい。
 */
/** 区切り1つの進み具合（録画中の文字起こしの表示 src/main/pipeline/stt/liveFeed.ts へ渡す） */
export interface TranscriberProgress {
  /** 待っている・処理中の区切りの数 */
  pending: number
  /** 済んだ区切りの結果（投入を知らせるときは無い） */
  segments?: TranscriptSegment[]
  error?: Error
}

export class IncrementalTranscriber {
  private readonly segments: TranscriptSegment[] = []
  private queue: Promise<void> = Promise.resolve()
  private readonly errors: Error[] = []
  private billedSeconds = 0
  private waiting = 0

  constructor(private readonly engine: SttEngine, private readonly onSegments?: (segments: TranscriptSegment[]) => Promise<void>,
    private readonly onProgress?: (progress: TranscriberProgress) => void) {}

  /** 待っている・処理中の区切りの数 */
  get pending(): number { return this.waiting }

  /** 表示の失敗で文字起こしを止めない */
  private notify(progress: TranscriberProgress): void {
    try { this.onProgress?.(progress) } catch { /* 表示だけの失敗（想定内） */ }
  }

  /** 区切り1つを投入する。待たずに返る。処理は1つずつ順に行う（同時に走らせない） */
  push(input: TranscribeChunkInput): void {
    this.waiting++
    this.notify({ pending: this.waiting })
    this.queue = this.queue.then(async () => {
      let done: TranscriberProgress | null = null
      try {
        const r = await this.engine.transcribeChunk(input)
        // 物音や無音に付いた効果音のタグ・決まり文句は話した言葉ではない（hallucination.ts）
        let pcm: Promise<{ samples: Int16Array; info: { sampleRate: number } } | null> | null = null
        const segments = await dropHallucinations(r.segments, async (t0, t1) => {
          pcm ??= readWavPcm(input.wavPath).catch(() => null) // 読めなければ音量で判断しない（想定内）
          const wav = await pcm
          return wav ? segmentDbfs(wav.samples, wav.info.sampleRate, input.offsetMs, t0, t1) : undefined
        })
        this.segments.push(...segments)
        this.billedSeconds += r.billedSeconds ?? 0
        done = { pending: 0, segments }
        await this.onSegments?.(segments)
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e))
        this.errors.push(error)
        done = { pending: 0, ...done, error }
      } finally {
        this.waiting--
        this.notify({ ...done, pending: this.waiting })
      }
    })
  }

  /** 投入済みの全部が終わるのを待ち、時刻順の区間を返す */
  async flush(): Promise<{ segments: TranscriptSegment[]; errors: Error[]; billedSeconds: number }> {
    await this.queue
    return {
      segments: [...this.segments].sort((a, b) => a.t0 - b.t0),
      errors: [...this.errors],
      billedSeconds: this.billedSeconds,
    }
  }

  /** 途中結果（UIの進捗表示用） */
  snapshot(): TranscriptSegment[] {
    return [...this.segments].sort((a, b) => a.t0 - b.t0)
  }
}
