import { describe, expect, it } from 'vitest'
import {
  SilenceSegmenter,
  dbfs,
  defaultSegmenterOptions,
  recommendedMaxChunkMs
} from '../../src/main/pipeline/stt/segmenter'
import type { AudioChunk } from '../../src/main/pipeline/stt/segmenter'
import { encodeWav } from '../../src/main/pipeline/stt/wav'
import { readWavInfo, readWavPcm } from '../../src/main/pipeline/stt/wav'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RATE = 16_000

/** 無音（ごく小さなノイズ） */
function silence(ms: number): Int16Array {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = (i % 7) - 3
  return out
}

/** 発話に見える信号（440Hzの正弦波） */
function voice(ms: number, amplitude = 8000): Int16Array {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE))
  return out
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Int16Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function collect(options: Partial<typeof defaultSegmenterOptions> = {}) {
  const chunks: AudioChunk[] = []
  const seg = new SilenceSegmenter((c) => {
    chunks.push(c)
  }, options)
  return { seg, chunks }
}

describe('無音区切り', () => {
  it('2秒以上の無音で区切り、発話ごとにチャンクを出す', async () => {
    const { seg, chunks } = collect()
    seg.push(concat(voice(1000), silence(2500), voice(1200), silence(2500), voice(800)))
    await seg.flush()

    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.durationMs).toBeGreaterThanOrEqual(1000)
    // 2件目は「1件目の発話 + 無音」のあとから始まる
    expect(chunks[1]!.offsetMs).toBeGreaterThan(2000)
    expect(chunks.every((c) => !c.cutMidSpeech)).toBe(true)
  })

  it('2秒未満の間しかない発話は1つのチャンクにまとめる', async () => {
    const { seg, chunks } = collect()
    seg.push(concat(voice(800), silence(1200), voice(800), silence(2500)))
    await seg.flush()
    expect(chunks).toHaveLength(1)
  })

  it('offsetMs は録画開始からの時刻になる（押し込んだ順に積み上がる）', async () => {
    const { seg, chunks } = collect()
    seg.push(silence(3000))
    seg.push(concat(voice(1000), silence(2500)))
    seg.push(concat(voice(1000), silence(2500)))
    await seg.flush()

    expect(chunks).toHaveLength(2)
    // 先頭の無音3秒は捨てられ、1件目は3秒付近から始まる（余白ぶん手前）
    expect(chunks[0]!.offsetMs).toBeGreaterThan(2500)
    expect(chunks[0]!.offsetMs).toBeLessThan(3100)
    // 2件目は 1件目の発話(1秒)＋無音(2.5秒) の後
    expect(chunks[1]!.offsetMs).toBeGreaterThan(chunks[0]!.offsetMs + 3000)
  })

  it('無音だけの区間はチャンクにしない（EXT-2）', async () => {
    const { seg, chunks } = collect()
    seg.push(silence(10_000))
    await seg.flush()
    expect(chunks).toHaveLength(0)
  })

  it('上限を超えても、話している途中では切らず無音の真ん中で切る', async () => {
    const { seg, chunks } = collect({ maxChunkMs: 5000, silenceMs: 2000 })
    // 2秒の無音は無いが、途中に0.6秒の無音がある長い発話
    seg.push(concat(voice(3000), silence(600), voice(3000), silence(2500)))
    await seg.flush()

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.every((c) => !c.cutMidSpeech)).toBe(true)
    // 1件目は 600ms の無音の真ん中あたりで切れている
    expect(chunks[0]!.durationMs).toBeGreaterThan(2800)
    expect(chunks[0]!.durationMs).toBeLessThan(3700)
  })

  it('無音がまったく無い場合はやむを得ず切り、cutMidSpeech で知らせる', async () => {
    const { seg, chunks } = collect({ maxChunkMs: 2000 })
    seg.push(voice(6000))
    await seg.flush()

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.some((c) => c.cutMidSpeech)).toBe(true)
    for (const c of chunks) expect(c.durationMs).toBeLessThanOrEqual(2100)
  })

  it('停止時に残っている発話を flush で出す', async () => {
    const { seg, chunks } = collect()
    seg.push(voice(1500)) // 末尾に無音が来ないまま停止
    expect(chunks).toHaveLength(0)
    await seg.flush()
    expect(chunks).toHaveLength(1)
  })

  it('短すぎる物音はチャンクにしない', async () => {
    const { seg, chunks } = collect({ minChunkMs: 250 })
    seg.push(concat(voice(100), silence(2500)))
    await seg.flush()
    expect(chunks).toHaveLength(0)
  })

  it('フレームに満たない端数をまたいでも、発話を落とさない', async () => {
    const { seg, chunks } = collect()
    const all = concat(voice(1000), silence(2500))
    // 奇数長で小刻みに流し込む
    for (let i = 0; i < all.length; i += 777) seg.push(all.subarray(i, Math.min(i + 777, all.length)))
    await seg.flush()
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.durationMs).toBeGreaterThanOrEqual(1000)
  })

  it('エンジン別の上限は、最後のチャンクが10秒以内に終わる長さになっている', () => {
    // 実測の処理速度（GPU 0.10×RT / CPU 0.32×RT）で10秒に収まること
    expect(recommendedMaxChunkMs('local-gpu') * 0.1).toBeLessThanOrEqual(10_000)
    expect(recommendedMaxChunkMs('local-cpu') * 0.32).toBeLessThanOrEqual(10_000)
    // OpenAI は 25MB（16kHzモノラルで約13分）の上限を超えない
    expect(recommendedMaxChunkMs('openai')).toBeLessThan(13 * 60 * 1000)
  })
})

describe('WAV の書き出し', () => {
  it('16kHz モノラル16bit として読み戻せる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ade-wav-'))
    const path = join(dir, 'a.wav')
    const samples = voice(1500)
    await writeFile(path, encodeWav(samples, RATE))

    const info = await readWavInfo(path)
    expect(info.sampleRate).toBe(RATE)
    expect(info.channels).toBe(1)
    expect(info.bitsPerSample).toBe(16)
    expect(info.durationMs).toBe(1500)
  })
})

describe('WAV ヘッダの読み取り', () => {
  it('fmt と data の間に別のチャンクがあっても PCM の位置を正しく求める', async () => {
    // macOS の say が出す WAV は fmt のあとに LIST チャンクが入る
    const samples = voice(500)
    const pcm = encodeWav(samples, RATE)
    const list = Buffer.alloc(8 + 26)
    list.write('LIST', 0, 'ascii')
    list.writeUInt32LE(26, 4)
    const withList = Buffer.concat([pcm.subarray(0, 36), list, pcm.subarray(36)])
    withList.writeUInt32LE(withList.length - 8, 4) // RIFF のサイズを直す

    const dir = await mkdtemp(join(tmpdir(), 'ade-wav2-'))
    const path = join(dir, 'list.wav')
    await writeFile(path, withList)

    const info = await readWavInfo(path)
    expect(info.dataOffset).toBe(36 + 34 + 8)
    expect(info.durationMs).toBe(500)

    const { samples: back } = await readWavPcm(path)
    expect(back.length).toBe(samples.length)
    expect(back[100]).toBe(samples[100])
  })
})

describe('非同期の書き出しとの組み合わせ', () => {
  it('flush は onChunk（WAVの書き出しなど）が終わるまで待つ', async () => {
    const handed: number[] = []
    const seg = new SilenceSegmenter(async (c) => {
      await new Promise((r) => setTimeout(r, 5))
      handed.push(c.offsetMs)
    })
    seg.push(concat(voice(1000), silence(2500), voice(1000)))
    // まだ書き出しは終わっていない
    expect(handed).toHaveLength(0)
    const { errors } = await seg.flush()
    // flush のあとは全区切りが渡っている（停止直後の取りこぼしが無い）
    expect(handed).toHaveLength(2)
    expect(errors).toHaveLength(0)
  })

  it('onChunk が失敗しても録画を止めず、理由を flush で返す', async () => {
    const seg = new SilenceSegmenter(async () => {
      throw new Error('ディスクが満杯')
    })
    seg.push(concat(voice(1000), silence(2500)))
    const { errors } = await seg.flush()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('ディスクが満杯')
  })

  it('区切りは押し込んだ順に渡る', async () => {
    const order: number[] = []
    const seg = new SilenceSegmenter(async (c) => {
      // 先の区切りほど遅くしても順番が崩れないこと
      await new Promise((r) => setTimeout(r, c.offsetMs === 0 ? 20 : 1))
      order.push(c.offsetMs)
    })
    seg.push(concat(voice(800), silence(2500), voice(800), silence(2500), voice(800)))
    await seg.flush()
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order).toHaveLength(3)
  })
})

describe('無音を文字起こしに回さない（04_benchmark.md 3.7）', () => {
  it('フレーム判定を通り抜けた小さな音も、区切り全体の音量(-45dBFS)で捨てる', async () => {
    // 騒がしい部屋・しきい値の設定ずれで、空調音がフレーム単位では「発話あり」になった状況。
    // 区切りを渡す直前の音量チェックが最後の砦になる
    const { seg, chunks } = collect({ silenceThreshold: 0.0002 })
    const faint = voice(1500, Math.round(32768 * 0.001)) // 約 -63dBFS
    seg.push(concat(faint, silence(2500)))
    const { droppedSilentChunks } = await seg.flush()
    expect(chunks).toHaveLength(0)
    expect(droppedSilentChunks).toBeGreaterThan(0)
  })

  it('フレーム判定で全て無音なら、そこで捨てる（二重の防ぎ方）', async () => {
    const { seg, chunks } = collect()
    seg.push(concat(voice(1500, Math.round(32768 * 0.001)), silence(2500)))
    await seg.flush()
    expect(chunks).toHaveLength(0)
  })

  it('しきい値を超える発話は通す', async () => {
    const { seg, chunks } = collect()
    seg.push(concat(voice(1500), silence(2500)))
    const { droppedSilentChunks } = await seg.flush()
    expect(chunks).toHaveLength(1)
    expect(droppedSilentChunks).toBe(0)
    expect(dbfs(chunks[0]!.samples)).toBeGreaterThan(-45)
  })

  it('しきい値は設定で変えられる', async () => {
    const { seg, chunks } = collect({ silenceThreshold: 0.0002, minChunkDbfs: -80 })
    seg.push(concat(voice(1500, Math.round(32768 * 0.001)), silence(2500)))
    await seg.flush()
    expect(chunks).toHaveLength(1)
  })

  it('dbfs は無音で -Infinity になる', () => {
    expect(dbfs(new Int16Array(1600))).toBe(-Infinity)
    expect(dbfs(new Int16Array(0))).toBe(-Infinity)
  })
})
