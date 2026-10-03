/**
 * 音声の無音区切り（設計 5章① 「録画中に無音区切り（2秒以上）で逐次実行する」）。
 *
 * 録画側は 16kHz モノラルの PCM を `push()` で流し込むだけでよい。
 * 区切りが決まるたびに、開始時刻つきのチャンクが `onChunk` へ渡る。
 * Electron にも whisper にも依存しない純粋なモジュールなので、単体テストできる。
 *
 * 守っていること:
 * - **話している途中では切らない。** 上限に達した場合も、バッファ内で最も長い無音の
 *   真ん中で切る。無音が全く無い場合だけやむを得ず切り、`cutMidSpeech` で知らせる。
 * - 無音だけのチャンクは出さない（指摘にならない区間は捨てる。EXT-2）。
 * - 先頭の無音は捨て、`offsetMs` は発話の始まりに寄せる。
 */

export interface AudioChunk {
  /** 16bit PCM（モノラル） */
  samples: Int16Array
  /** このチャンクの先頭が録画開始から何ms後か */
  offsetMs: number
  durationMs: number
  /** 無音が見つからず、発話の途中で切った（精度が落ちうる。ログに出す） */
  cutMidSpeech: boolean
}

export interface SegmenterOptions {
  sampleRate: number
  /** 区切りと見なす無音の長さ(ms) */
  silenceMs: number
  /** 無音と見なす振幅（RMS、0〜1）。16bit を -1..1 に正規化した値 */
  silenceThreshold: number
  /**
   * チャンク全体の音量がこれ以下なら、文字起こしに回さず捨てる(dBFS)。
   *
   * **無音に whisper をかけると毎回違うでたらめな文が出る**（先行例の実測。04_benchmark.md 3.7）。
   * フレーム単位の無音判定だけだと、しきい値ぎりぎりの物音が1フレーム混ざった区切りが
   * そのまま通ってしまうので、チャンクを渡す直前にもう一度全体の音量で見る。
   */
  minChunkDbfs: number
  /**
   * チャンクの長さの上限(ms)。超えたら無音を待たずに区切る。
   * 停止後の待ち時間（NF-3: 10秒以内）は「最後のチャンクの処理時間」で決まるため、
   * エンジンの処理速度から決める。`recommendedMaxChunkMs()` を使う。
   */
  maxChunkMs: number
  /**
   * これ未満しか発話が無いチャンクは出さずに捨てる(ms)。末尾の無音は長さに数えない。
   * 「はい」のような短い返事を落とさないよう控えめにし、
   * つなぎ言葉の除外は後段のLLM（③整理）に任せる。
   */
  minChunkMs: number
  /** 上限で切るときに許容する最短の無音(ms)。これ未満なら発話の途中とみなす */
  fallbackSilenceMs: number
  /** 発話の前後に残す余白(ms)。語頭・語尾の切り落ちを防ぐ */
  padMs: number
}

export const defaultSegmenterOptions: SegmenterOptions = {
  sampleRate: 16_000,
  silenceMs: 2000,
  silenceThreshold: 0.012,
  minChunkDbfs: -45,
  maxChunkMs: 60_000,
  minChunkMs: 250,
  fallbackSilenceMs: 300,
  padMs: 200
}

/** 1フレームの長さ(ms)。無音判定の粒度 */
const FRAME_MS = 20

export type SttEngineKind = 'local-gpu' | 'local-cpu' | 'openai'

/**
 * エンジン別のチャンク上限。
 * 技術検証の実測（05_pipeline_findings.md）から、「最後のチャンクの処理時間が
 * 10秒に収まる長さ」を選んでいる。
 *   ローカル(GPU/Metal) large-v3-turbo … 音声長の約0.10倍 → 60秒で約6秒
 *   ローカル(CPUのみ) small           … 約0.32倍         → 30秒で約10秒
 *   OpenAI                            … 回線依存で1〜2秒。25MB上限（約13分）が効く
 */
export function recommendedMaxChunkMs(kind: SttEngineKind): number {
  switch (kind) {
    case 'local-gpu':
      return 60_000
    case 'local-cpu':
      return 30_000
    case 'openai':
      return 120_000
  }
}

interface Frame {
  silent: boolean
}

export class SilenceSegmenter {
  private readonly opt: SegmenterOptions
  private readonly samplesPerFrame: number
  /** 未確定の音声（フレーム境界に揃っている） */
  private buffer: Int16Array
  private bufferLength = 0
  private readonly frames: Frame[] = []
  /** buffer の先頭が録画開始から何ms後か */
  private bufferStartMs = 0
  /** フレームに満たない端数 */
  private remainder: Int16Array = new Int16Array(0)
  /**
   * onChunk の呼び出しを直列に繋いだもの。
   * onChunk は WAV の書き出しなど非同期なことをするため、`flush()` がこれを待つ。
   * 待たないと、停止直後に文字起こしへ渡る前の区切りを取りこぼす。
   */
  private handing: Promise<void> = Promise.resolve()
  private readonly handErrors: Error[] = []
  /** 音量が足りず文字起こしに回さなかった区切りの数（計測・ログ用） */
  private droppedSilentChunks = 0

  constructor(
    private readonly onChunk: (chunk: AudioChunk) => void | Promise<void>,
    options: Partial<SegmenterOptions> = {}
  ) {
    this.opt = { ...defaultSegmenterOptions, ...options }
    this.samplesPerFrame = Math.round((this.opt.sampleRate * FRAME_MS) / 1000)
    this.buffer = new Int16Array(this.samplesPerFrame * 256)
  }

  /** 録画側はこれを呼ぶだけ。待たずに返る */
  push(pcm: Int16Array): void {
    const joined = concat(this.remainder, pcm)
    const usableFrames = Math.floor(joined.length / this.samplesPerFrame)
    const usable = usableFrames * this.samplesPerFrame
    this.remainder = joined.subarray(usable).slice()

    for (let i = 0; i < usableFrames; i++) {
      const frame = joined.subarray(i * this.samplesPerFrame, (i + 1) * this.samplesPerFrame)
      this.appendFrame(frame)
    }
    this.cutIfPossible()
  }

  /**
   * 停止時。残りを吐き出し、**すべての onChunk が終わるまで待つ**。
   * 返ってきた時点で、全区切りが文字起こしへ渡っている。
   */
  async flush(): Promise<{ errors: Error[]; droppedSilentChunks: number }> {
    if (this.remainder.length > 0) {
      // 端数はゼロ詰めして1フレームにする
      const frame = new Int16Array(this.samplesPerFrame)
      frame.set(this.remainder)
      this.appendFrame(frame)
      this.remainder = new Int16Array(0)
    }
    this.emitRange(this.frames.length, false)
    await this.handing
    return { errors: [...this.handErrors], droppedSilentChunks: this.droppedSilentChunks }
  }

  private appendFrame(frame: Int16Array): void {
    if (this.bufferLength + frame.length > this.buffer.length) {
      const grown = new Int16Array(Math.max(this.buffer.length * 2, this.bufferLength + frame.length))
      grown.set(this.buffer.subarray(0, this.bufferLength))
      this.buffer = grown
    }
    this.buffer.set(frame, this.bufferLength)
    this.bufferLength += frame.length
    this.frames.push({ silent: rms(frame) < this.opt.silenceThreshold })
  }

  private cutIfPossible(): void {
    for (;;) {
      // 先頭の無音は捨てる（offsetMs を発話の始まりに寄せる）
      this.dropLeadingSilence()
      if (this.frames.length === 0) return

      const padFrames = Math.round(this.opt.padMs / FRAME_MS)
      const maxFrames = Math.max(1, Math.round(this.opt.maxChunkMs / FRAME_MS))
      const silenceFrames = Math.round(this.opt.silenceMs / FRAME_MS)

      // 通常の区切り: 発話のあとに silenceMs 以上の無音がある（末尾でも途中でもよい）
      const run = this.firstSilenceRun(silenceFrames)
      if (run && run.start <= maxFrames) {
        const keep = Math.min(this.frames.length, run.start + padFrames)
        if (this.emitRange(keep, false) === 'kept') return
        continue
      }

      // 上限に達した: 話している途中で切らないよう、上限までの範囲で最も長い無音の真ん中で切る
      if (this.frames.length >= maxFrames) {
        const best = this.longestSilence(maxFrames)
        if (best && best.length * FRAME_MS >= this.opt.fallbackSilenceMs) {
          const mid = best.start + Math.floor(best.length / 2)
          if (this.emitRange(mid, false) === 'kept') return
        } else {
          // 無音が見つからない。上限を守るためやむを得ず切る
          if (this.emitRange(maxFrames, true) === 'kept') return
        }
        continue
      }
      return
    }
  }

  /**
   * 発話のあとに続く、長さ `minFrames` 以上の無音の始まり。
   * 末尾の無音も途中の無音も同じように扱う（まとめて push された場合に備える）。
   */
  private firstSilenceRun(minFrames: number): { start: number; length: number } | undefined {
    let runStart = -1
    for (let i = 0; i <= this.frames.length; i++) {
      const silent = i < this.frames.length && this.frames[i]!.silent
      if (silent && runStart < 0) runStart = i
      if (!silent && runStart >= 0) {
        if (runStart > 0 && i - runStart >= minFrames) return { start: runStart, length: i - runStart }
        runStart = -1
      }
    }
    // 末尾まで続く無音
    if (runStart > 0 && this.frames.length - runStart >= minFrames) {
      return { start: runStart, length: this.frames.length - runStart }
    }
    return undefined
  }

  private dropLeadingSilence(): void {
    let n = 0
    while (n < this.frames.length && this.frames[n]!.silent) n++
    if (n === 0) return
    // 余白ぶんは残す
    const pad = Math.round(this.opt.padMs / FRAME_MS)
    const drop = Math.max(0, n - pad)
    if (drop === 0) return
    this.consume(drop)
  }

  /** 上限までの範囲で最も長い無音（先頭の無音は捨てる対象なので除く） */
  private longestSilence(limitFrames: number): { start: number; length: number } | undefined {
    const end = Math.min(this.frames.length, limitFrames)
    let best: { start: number; length: number } | undefined
    let runStart = -1
    for (let i = 0; i <= end; i++) {
      const silent = i < end && this.frames[i]!.silent
      if (silent && runStart < 0) runStart = i
      if (!silent && runStart >= 0) {
        const length = i - runStart
        if (runStart > 0 && (!best || length > best.length)) best = { start: runStart, length }
        runStart = -1
      }
    }
    return best
  }

  /**
   * 先頭から frameCount フレームを1チャンクとして出す。
   *   emitted … チャンクを出した
   *   dropped … 発話が無い（または短すぎる物音）ので捨てた
   *   kept    … 判断できないので繰り越した（呼び出し側はループを抜ける）
   */
  private emitRange(frameCount: number, cutMidSpeech: boolean): 'emitted' | 'dropped' | 'kept' {
    if (frameCount <= 0) return 'kept'
    const range = this.frames.slice(0, frameCount)
    const voicedFrames = range.filter((f) => !f.silent).length
    // 「短い」の判定は発話の長さで見る（末尾の無音を長さに数えない）
    const voicedMs = voicedFrames * FRAME_MS

    if (voicedFrames === 0 || (voicedMs < this.opt.minChunkMs && !cutMidSpeech)) {
      // 無音だけ、または物音だけ。捨てて時刻を進める
      this.consume(frameCount)
      return 'dropped'
    }

    const sampleCount = frameCount * this.samplesPerFrame
    const samples = this.buffer.slice(0, sampleCount)

    // 無音を文字起こしに回さない（回すとでたらめな文が返る）
    if (dbfs(samples) <= this.opt.minChunkDbfs) {
      this.consume(frameCount)
      this.droppedSilentChunks += 1
      return 'dropped'
    }

    const chunk: AudioChunk = {
      samples,
      offsetMs: this.bufferStartMs,
      durationMs: frameCount * FRAME_MS,
      cutMidSpeech
    }
    this.consume(frameCount)
    // 呼び出しは直列に繋ぐ（順番を保ち、flush() が待てるようにする）
    this.handing = this.handing.then(async () => {
      try {
        await this.onChunk(chunk)
      } catch (e) {
        this.handErrors.push(e instanceof Error ? e : new Error(String(e)))
      }
    })
    return 'emitted'
  }

  /** 先頭から frameCount フレームを捨て、時刻を進める */
  private consume(frameCount: number): void {
    const sampleCount = frameCount * this.samplesPerFrame
    this.buffer.copyWithin(0, sampleCount, this.bufferLength)
    this.bufferLength -= sampleCount
    this.frames.splice(0, frameCount)
    this.bufferStartMs += frameCount * FRAME_MS
  }
}

/** 全体の音量(dBFS)。無音なら -Infinity に近い値になる */
export function dbfs(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity
  const r = rms(samples)
  return r <= 0 ? -Infinity : 20 * Math.log10(r)
}

function rms(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]! / 32768
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  if (a.length === 0) return b
  const out = new Int16Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * チャンクを WAV ファイルへ書き出して、文字起こしへ渡せる形にする。
 * 録画側はこれを `SilenceSegmenter` の `onChunk` に繋ぐ。
 */
export function wavChunkWriter(
  dir: string,
  sampleRate: number,
  onFile: (file: { wavPath: string; offsetMs: number; durationMs: number; cutMidSpeech: boolean }) => void | Promise<void>
): (chunk: AudioChunk) => Promise<void> {
  let n = 0
  return async (chunk) => {
    const { join } = await import('node:path')
    const { writeWavFile } = await import('./wav')
    const wavPath = join(dir, `chunk-${String(n++).padStart(4, '0')}-${chunk.offsetMs}.wav`)
    await writeWavFile(wavPath, chunk.samples, sampleRate)
    await onFile({
      wavPath,
      offsetMs: chunk.offsetMs,
      durationMs: chunk.durationMs,
      cutMidSpeech: chunk.cutMidSpeech
    })
  }
}
