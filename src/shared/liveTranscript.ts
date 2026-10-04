/**
 * 録画中の文字起こしの途中経過（フィードバックの右パネル「文字起こし」タブ）。
 *
 * ねらい: 10分20分話したあとで「何も文字になっていなかった」と知るのを防ぐ。
 * main は区切り（無音で切った WAV）を1つずつ順に文字起こししている（pipeline/stt/engine.ts の IncrementalTranscriber）。
 * その結果と状態をここの形で画面へ送り、画面は並べて見せ、止まっていれば早めに知らせる。
 *
 * Electron にも React にも依存しない純粋な関数だけを置く（main・画面・単体テストで共有する）。
 */

export type LiveTranscriptSource = 'mic' | 'system'

/** 1つの発話。t0/t1 は録画開始からの ms */
export interface LiveTranscriptSegment {
  t0: number
  t1: number
  text: string
  /** mic = 自分、system = 相手（PC の音声） */
  source: LiveTranscriptSource
}

/**
 * 文字起こしの状態。
 * - off: 録っていない、または音を録らない録画
 * - idle: 待っている区切りが無い（話していないか、追いついている）
 * - working: 区切りを処理中（pending 件が待ち）
 * - error: 直近の区切りが失敗した（message に理由）
 * - unavailable: 文字起こしが動いていない（モデルやキーが無い。録音は続く。message に理由）
 */
export type LiveTranscriptState = 'off' | 'idle' | 'working' | 'error' | 'unavailable'

/**
 * 推測による警告。
 * - stalled: マイクに声が入り続けているのに、しばらく文字が1つも出ていない
 * - micSilent: マイクの音がまったく届いていない（ミュート・別のマイクを選んでいる）
 */
export type LiveTranscriptWarning = 'stalled' | 'micSilent'

export interface LiveTranscriptStatus {
  /** 録画ごとに増える番号。変わったら画面は前の録画の文字を捨てる */
  run: number
  /** 録画中か（止めたあとも最後の文字は見せる） */
  active: boolean
  state: LiveTranscriptState
  /** 待っている・処理中の区切りの数 */
  pending: number
  /** 文字起こしできた区切りの数 */
  done: number
  /** 失敗した区切りの数 */
  failed: number
  /** 相手の声（PC の音声）も録っているか。自分／相手の表示に使う */
  twoSpeakers: boolean
  message?: string
  warning?: LiveTranscriptWarning
}

/** 'transcript:segments' で送る中身 */
export interface LiveTranscriptBatch {
  run: number
  segments: LiveTranscriptSegment[]
}

/** 1つの発話の文字の上限（whisper の 60 秒の区切りでも十分に収まる） */
export const LIVE_SEGMENT_MAX_TEXT = 2000
/** 1回で送る発話の上限 */
export const LIVE_BATCH_MAX = 200
/** 画面に持つ発話の上限（古いものから捨てる。録画の文字起こしそのものは transcript.jsonl に全部残る） */
export const LIVE_KEEP_MAX = 3000
/** 理由の文の上限 */
export const LIVE_MESSAGE_MAX = 500

const STATES: readonly LiveTranscriptState[] = ['off', 'idle', 'working', 'error', 'unavailable']
const WARNINGS: readonly LiveTranscriptWarning[] = ['stalled', 'micSilent']

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 1_000_000) : 0)
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export const IDLE_LIVE_STATUS: LiveTranscriptStatus = { run: 0, active: false, state: 'off', pending: 0, done: 0, failed: 0, twoSpeakers: false }

/** 届いた発話を確かめて直す。文字が無い・時刻が壊れているものは null */
export function sanitizeLiveSegment(raw: unknown): LiveTranscriptSegment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.text !== 'string') return null
  const text = clip(r.text.replace(/\s+/g, ' ').trim(), LIVE_SEGMENT_MAX_TEXT)
  if (!text) return null
  if (typeof r.t0 !== 'number' || !Number.isFinite(r.t0) || r.t0 < 0) return null
  const t0 = Math.round(r.t0)
  const t1 = typeof r.t1 === 'number' && Number.isFinite(r.t1) && r.t1 >= t0 ? Math.round(r.t1) : t0
  return { t0, t1, text, source: r.source === 'system' ? 'system' : 'mic' }
}

/** 届いた状態を確かめて直す */
export function sanitizeLiveStatus(raw: unknown): LiveTranscriptStatus {
  if (typeof raw !== 'object' || raw === null) return { ...IDLE_LIVE_STATUS }
  const r = raw as Record<string, unknown>
  const state = STATES.includes(r.state as LiveTranscriptState) ? r.state as LiveTranscriptState : 'off'
  const out: LiveTranscriptStatus = {
    run: count(r.run), active: r.active === true, state,
    pending: count(r.pending), done: count(r.done), failed: count(r.failed), twoSpeakers: r.twoSpeakers === true
  }
  if (typeof r.message === 'string' && r.message.trim()) out.message = clip(r.message.trim(), LIVE_MESSAGE_MAX)
  if (WARNINGS.includes(r.warning as LiveTranscriptWarning)) out.warning = r.warning as LiveTranscriptWarning
  return out
}

/** 届いた発話の束を確かめて直す */
export function sanitizeLiveBatch(raw: unknown): LiveTranscriptBatch | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.segments)) return null
  const segments = r.segments.slice(0, LIVE_BATCH_MAX).map(sanitizeLiveSegment).filter((s): s is LiveTranscriptSegment => s !== null)
  return { run: count(r.run), segments }
}

/**
 * 発話を時刻順に足す。区切りは順に処理するが、自分と相手は別々に区切るので時刻が前後しうる。
 * 同じ時刻・同じ系統・同じ文は二度足さない。上限を超えたら古いものから捨てる
 */
export function addLiveSegments(list: readonly LiveTranscriptSegment[], added: readonly LiveTranscriptSegment[], max = LIVE_KEEP_MAX): LiveTranscriptSegment[] {
  if (added.length === 0) return list as LiveTranscriptSegment[]
  const out = [...list]
  for (const seg of added) {
    if (out.some((s) => s.t0 === seg.t0 && s.source === seg.source && s.text === seg.text)) continue
    // 末尾から探す（ほとんどは末尾に付く）
    let i = out.length
    while (i > 0 && out[i - 1].t0 > seg.t0) i--
    out.splice(i, 0, seg)
  }
  return out.length > max ? out.slice(out.length - max) : out
}

/** 知らせるべき問題があるか（パネルの外でも印を出す） */
export function liveTranscriptProblem(status: LiveTranscriptStatus): 'error' | 'unavailable' | LiveTranscriptWarning | null {
  if (!status.active) return null
  if (status.state === 'unavailable') return 'unavailable'
  if (status.state === 'error') return 'error'
  return status.warning ?? null
}

/** mm:ss（1時間を超えたら h:mm:ss） */
export function formatLiveTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export type LiveStatusLine = 'off' | 'noAudio' | 'idle' | 'working' | 'error' | 'unavailable' | 'done'

/** パネルの上の1行で何を言うか。tone は色（danger は赤、busy は動いている印） */
export function liveStatusLine(status: LiveTranscriptStatus): { line: LiveStatusLine; tone: 'muted' | 'ok' | 'busy' | 'danger' } {
  if (!status.active) return { line: status.run === 0 ? 'off' : 'done', tone: 'muted' }
  switch (status.state) {
    case 'off': return { line: 'noAudio', tone: 'muted' }
    case 'unavailable': return { line: 'unavailable', tone: 'danger' }
    case 'error': return { line: 'error', tone: 'danger' }
    case 'working': return { line: 'working', tone: 'busy' }
    default: return { line: 'idle', tone: 'ok' }
  }
}

/**
 * 「声は入っているのに文字にならない」「マイクの音が届いていない」を見張る。
 * マイクのレベル（100ms ごとの RMS）と、文字起こしの進み具合だけから決める。
 *
 * - stalled: 最後に文字が出てから、声の大きさの音が合計 stallSpeechMs 以上入り、
 *   しかも待っている区切りが無い（= 区切りは処理し終えたのに文字が出なかった）。
 *   区切りの上限は 60 秒なので、2 分話せば少なくとも 1 区切りは処理済みになっている
 * - micSilent: 録り始めから silentMs のあいだ、マイクの音がほぼ 0（デジタルの無音）。
 *   実際のマイクは静かな部屋でも小さな雑音が入るので、0 が続くのはミュートか別のマイク
 */
export class SpeechStallWatch {
  private speechMs = 0
  private micMs = 0
  private heard = false
  private stalled = false
  private silent = false

  constructor(private readonly options: { speechRms?: number; stallSpeechMs?: number; silentPeak?: number; silentMs?: number } = {}) {}

  /** マイクの1ブロック分のレベル。警告が変わったら true */
  level(rms: number, peak: number, blockMs = 100): boolean {
    const before = this.warning()
    this.micMs += blockMs
    if (peak >= (this.options.silentPeak ?? 0.001)) this.heard = true
    if (rms >= (this.options.speechRms ?? 0.03)) this.speechMs += blockMs
    if (!this.heard && this.micMs >= (this.options.silentMs ?? 20_000)) this.silent = true
    if (this.heard) this.silent = false
    return before !== this.warning()
  }

  /** 文字が出た。警告が変わったら true */
  text(): boolean {
    const before = this.warning()
    this.speechMs = 0
    this.stalled = false
    return before !== this.warning()
  }

  /** 待っている区切りの数を見て stalled を決める。警告が変わったら true */
  check(pending: number): boolean {
    const before = this.warning()
    if (!this.stalled && pending === 0 && this.speechMs >= (this.options.stallSpeechMs ?? 120_000)) this.stalled = true
    return before !== this.warning()
  }

  warning(): LiveTranscriptWarning | undefined {
    if (this.silent) return 'micSilent'
    return this.stalled ? 'stalled' : undefined
  }
}
