/**
 * WAV ヘッダの最小限の読み取り。
 * 時刻を返さないモデル（gpt-transcribe）で、チャンクの長さを知るために使う。
 * ffprobe を呼ばずに済ませる（アプリに ffmpeg を同梱しないため）。
 */
import { open } from 'node:fs/promises'

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataBytes: number
  durationMs: number
  /**
   * PCM本体が始まるバイト位置。
   * `LIST` などのチャンクが fmt と data の間に入ることがあり、44 固定では読めない
   * （macOS の `say` が出す WAV が実際にそうだった）。PCMを読み直すときは必ずこれを使う。
   */
  dataOffset: number
}

/** RIFF/WAVE のチャンクを辿って fmt と data を読む */
export async function readWavInfo(path: string): Promise<WavInfo> {
  const fh = await open(path, 'r')
  try {
    const head = Buffer.alloc(12)
    await fh.read(head, 0, 12, 0)
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`WAV ではありません: ${path}`)
    }

    let pos = 12
    let sampleRate = 0
    let channels = 0
    let bitsPerSample = 0
    let dataBytes = 0
    let dataOffset = 0
    const header = Buffer.alloc(8)

    for (;;) {
      const { bytesRead } = await fh.read(header, 0, 8, pos)
      if (bytesRead < 8) break
      const id = header.toString('ascii', 0, 4)
      const size = header.readUInt32LE(4)

      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 16))
        await fh.read(fmt, 0, fmt.length, pos + 8)
        channels = fmt.readUInt16LE(2)
        sampleRate = fmt.readUInt32LE(4)
        bitsPerSample = fmt.length >= 16 ? fmt.readUInt16LE(14) : 16
      } else if (id === 'data') {
        dataBytes = size
        dataOffset = pos + 8
        break
      }
      // チャンクは偶数バイト境界に揃う
      pos += 8 + size + (size % 2)
    }

    if (!sampleRate || !channels || !bitsPerSample) throw new Error(`WAV の fmt を読めません: ${path}`)
    const bytesPerFrame = (bitsPerSample / 8) * channels
    const durationMs = Math.round((dataBytes / bytesPerFrame / sampleRate) * 1000)
    return { sampleRate, channels, bitsPerSample, dataBytes, durationMs, dataOffset }
  } finally {
    await fh.close()
  }
}

export async function wavDurationMs(path: string): Promise<number> {
  return (await readWavInfo(path)).durationMs
}

/** 16bit PCM を WAV（RIFF）に包む。モノラル前提 */
export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt チャンクの長さ
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // モノラル
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // バイト毎秒
  buf.writeUInt16LE(2, 32) // ブロックサイズ
  buf.writeUInt16LE(16, 34) // ビット深度
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, 44 + i * 2)
  return buf
}

/** WAV を書き出す。16kHz モノラル 16bit（whisper.cpp / OpenAI の想定入力） */
export async function writeWavFile(
  path: string,
  samples: Int16Array,
  sampleRate: number
): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  // 排他で作る（同じ名前が先にあれば失敗する）。レビューのフォルダの中に先回りで置かれたリンクをたどって外へ書かない。
  // 呼び出し側はどれも新しい名前で書く（録画ごとの連番＋時刻、追記録画は takes/<n> の新しいフォルダ、接続の確認は一時フォルダ）
  await writeFile(path, encodeWav(samples, sampleRate), { flag: 'wx' })
}

/** WAV ファイルから 16bit PCM を読み出す（データの開始位置はヘッダから求める） */
export async function readWavPcm(path: string): Promise<{ samples: Int16Array; info: WavInfo }> {
  const { readFile } = await import('node:fs/promises')
  const info = await readWavInfo(path)
  if (info.bitsPerSample !== 16) throw new Error(`16bit PCM ではありません: ${path}`)
  const raw = await readFile(path)
  const start = raw.byteOffset + info.dataOffset
  const samples = new Int16Array(raw.buffer.slice(start, start + info.dataBytes))
  return { samples, info }
}
