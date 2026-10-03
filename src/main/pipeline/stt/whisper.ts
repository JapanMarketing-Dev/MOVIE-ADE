/**
 * ① 文字起こし — whisper.cpp（whisper-cli）のラッパー。
 *
 * 録画中に無音の区切りごとに呼べるよう、「1つの 16kHz モノラル WAV ＋ 時刻オフセット」を
 * 受け取って時刻つき区間を返す形にしている（設計1.3「停止 → 下書き一覧（10秒以内）」）。
 * 返す時刻は録画開始からのミリ秒。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { TranscriptSegment } from '../types'

/** 文字起こしの言語。`'auto'` も明示的に渡す（省略＝英語になるため） */
export type SttLanguage = 'ja' | 'en' | 'auto' | (string & {})
import type { SttEngine, TranscribeChunkInput, TranscribeResult } from './engine'
import { t as translateMessage } from '@shared/i18n'

export interface WhisperOptions {
  /** whisper-cli の実行パス。アプリでは同梱バイナリを指す */
  binary: string;
  /** ggml モデルファイルの絶対パス */
  model: string;
  /**
   * 言語。`'ja'` / `'en'` / `'auto'`（EXT-1: 日本語・英語）。
   *
   * **必ず渡す。** whisper.cpp の `-l` の既定は `en` なので、省略は「自動判別」ではなく
   * 「英語として書き起こす」になる。日本語が静かに全部英語扱いになる
   * （先行例の実測。04_benchmark.md 3.7「最重要の罠」）。
   * 設定が「自動」のときは `'auto'` を明示的に渡す。
   */
  language: SttLanguage;
  /** 使うスレッド数。既定は論理コア数の半分程度 */
  threads?: number;
  /** 初期プロンプト。UI用語を与えると誤変換が減る */
  initialPrompt?: string;
  /** 貪欲デコード（beam 1）にして速度を優先する */
  greedy?: boolean;
  /** 非音声トークン（（音楽）など）を抑制する */
  suppressNonSpeech?: boolean;
  /** GPU を使わない（CPUのみ環境の再現・検証用） */
  noGpu?: boolean;
  /** タイムアウト(ms)。既定 10分 */
  timeoutMs?: number;
  /** 中間ファイルを置くフォルダ。既定は OS の一時フォルダ */
  workDir?: string
}

interface WhisperJsonSegment {
  timestamps?: { from: string; to: string }
  offsets?: { from: number; to: number }
  text?: string
}

interface WhisperJson {
  transcription?: WhisperJsonSegment[]
}

/**
 * whisper-cli に渡す引数を組み立てる（テストしやすいよう純関数に切り出す）。
 * `-l` を必ず含める（省略すると英語扱いになるため）。
 */
export function buildWhisperArgs(opt: WhisperOptions, wavPath: string, outPrefix: string): string[] {
  const language = normalizeLanguage(opt.language)
  const args = [
    '-m', opt.model,
    '-f', wavPath,
    '-l', language,
    '-oj',
    '-of', outPrefix,
    '-np',
  ]
  if (opt.threads !== undefined) args.push('-t', String(opt.threads))
  if (opt.greedy) args.push('-bo', '1', '-bs', '1')
  if (opt.suppressNonSpeech) args.push('-sns')
  if (opt.noGpu) args.push('-ng')
  if (opt.initialPrompt) args.push('--prompt', opt.initialPrompt)
  return args
}

/**
 * 区切り1つ分を文字起こしする。録画中に区切りごとに繰り返し呼ぶ。
 * 失敗時は例外を投げる（呼び出し側で下書きへフォールバックできるよう、部分結果は返さない）。
 */
export async function transcribeChunk(
  input: TranscribeChunkInput,
  opt: WhisperOptions,
): Promise<TranscribeResult> {
  const dir = opt.workDir ?? (await mkdtemp(join(tmpdir(), 'ade-stt-')))
  const ownsDir = opt.workDir === undefined
  const outPrefix = join(dir, `chunk-${input.offsetMs}`)
  const args = buildWhisperArgs(opt, input.wavPath, outPrefix)
  const commandLine = [opt.binary, ...args].join(' ')

  const started = Date.now()
  try {
    await run(opt.binary, args, opt.timeoutMs ?? 600_000)
    const raw = await readFile(`${outPrefix}.json`, 'utf8')
    const parsed = JSON.parse(raw) as WhisperJson
    return {
      segments: toSegments(parsed, input),
      elapsedMs: Date.now() - started,
      commandLine,
    }
  } finally {
    // 一時フォルダの片付け（OS が後で消す。想定内）
    if (ownsDir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function toSegments(parsed: WhisperJson, input: TranscribeChunkInput): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  for (const s of parsed.transcription ?? []) {
    const text = cleanText(s.text ?? '')
    if (!text) continue
    const from = s.offsets?.from ?? parseTimestamp(s.timestamps?.from)
    const to = s.offsets?.to ?? parseTimestamp(s.timestamps?.to)
    if (from === undefined || to === undefined) continue
    out.push({
      t0: input.offsetMs + from,
      t1: input.offsetMs + to,
      speaker: input.speaker,
      text,
      source: input.source,
    })
  }
  return out
}

/** whisper が出す無音・BGMのプレースホルダや前後の空白を落とす */
export function cleanText(text: string): string {
  let t = text.trim()
  t = t.replace(/^\[[^\]]*\]$/, '')
  t = t.replace(/^[（(](?:音楽|拍手|BGM|笑|無音|沈黙)[^)）]*[)）]$/i, '')
  t = t.replace(/\[(?:BLANK_AUDIO|SOUND|MUSIC|INAUDIBLE)\]/gi, '')
  return t.trim()
}

/** "00:00:03,240" → 3240 */
function parseTimestamp(ts: string | undefined): number | undefined {
  if (!ts) return undefined
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(ts.trim())
  if (!m) return undefined
  const [, h = '0', mi = '0', s = '0', ms = '0'] = m
  return (
    Number(h) * 3_600_000 + Number(mi) * 60_000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'))
  )
}

function run(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(translateMessage('stt.whisper.timeout', { ms: timeoutMs })))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${translateMessage('stt.whisper.exited', { code })}\n${stderr.slice(-2000)}`))
    })
  })
}

/** whisper.cpp を使う文字起こしエンジン（既定。音声は端末外へ出ない） */
export class WhisperCppEngine implements SttEngine {
  readonly id: string
  readonly sendsAudioOffDevice = false

  constructor(private readonly opt: WhisperOptions) {
    this.id = `whisper.cpp:${basename(opt.model).replace(/^ggml-|\.bin$/g, '')}`
  }

  async available(): Promise<boolean> {
    return existsSync(this.opt.binary) && existsSync(this.opt.model)
  }

  transcribeChunk(input: TranscribeChunkInput): Promise<TranscribeResult> {
    return transcribeChunk(input, this.opt)
  }
}

/**
 * 設定の言語を whisper / OpenAI に渡す形へ直す。
 * 空・未知の値でも「省略」にはせず `auto` にする（英語扱いを避ける）。
 */
export function normalizeLanguage(language: string | undefined): SttLanguage {
  const v = (language ?? '').trim().toLowerCase()
  if (v === '' || v === 'auto') return 'auto'
  return v as SttLanguage
}
