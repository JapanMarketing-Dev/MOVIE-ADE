/**
 * mtg の取り込み（録画・文字起こし → 指摘の候補 → 人が確かめて Agent へ）で、main と renderer が共有する型と純粋な処理。
 *
 * 流れ:
 *   1. 画面で動画（任意）と文字起こし（ファイルか貼り付け。任意）を選ぶ。どちらか一方は要る
 *   2. main が新しいレビューを作る。文字起こしが無ければ動画の音声から起こす（設定の文字起こし）。
 *      動画があれば発話の時刻のコマを撮り、指摘の BEFORE の画像にする（meeting/import.ts）
 *   3. 「指摘の整理」（設定の整理のモデル）で、発話から指摘の候補を作る（review:organize と同じ処理）
 *   4. 判定モデル（設定で有効にしたときだけ）で、候補ごとに「製品の画面・挙動を変える具体的な依頼か」を確かめ、
 *      確からしさを付ける。しきい値より低い候補は、送る対象から外した状態にしておく（人が戻せる）
 *   5. 人が確認画面で候補を確かめ（編集・外す・画像の差し替え）、Agent へ送る。直ったら BEFORE / AFTER を人が見る
 *
 * Ferret が勝手に従量課金の API を使い始めることはない（文字起こし・整理・判定は、利用者が設定したものだけ）。
 */

/** 取り込める動画・音声の拡張子（Chromium が再生できるもの） */
export const MEETING_MEDIA_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'm4a', 'mp3', 'wav', 'ogg', 'aac'] as const
export type MeetingMediaExtension = typeof MEETING_MEDIA_EXTENSIONS[number]
/** 取り込める文字起こしのファイルの拡張子 */
export const MEETING_TRANSCRIPT_EXTENSIONS = ['txt', 'md', 'vtt', 'srt', 'docx'] as const

export function meetingMediaExtension(name: string): MeetingMediaExtension | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return (MEETING_MEDIA_EXTENSIONS as readonly string[]).includes(ext) ? ext as MeetingMediaExtension : null
}

/** 音声だけのファイル（コマは撮れない） */
export function isAudioOnly(ext: MeetingMediaExtension): boolean {
  return ext === 'm4a' || ext === 'mp3' || ext === 'wav' || ext === 'ogg' || ext === 'aac'
}

/** 動画の Content-Type（ade-media が返す） */
export function meetingMediaType(ext: MeetingMediaExtension): string {
  const types: Record<MeetingMediaExtension, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
    m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac'
  }
  return types[ext]
}

/** 選んだ動画（main が覚えておき、画面には名前と大きさだけを渡す。パスは渡さない） */
export interface MeetingMediaPick {
  token: string
  name: string
  sizeBytes: number
}

/** 選んだ文字起こしのファイル（main が読んだ文） */
export interface MeetingTranscriptPick {
  name: string
  text: string
}

export interface MeetingImportRequest {
  /** meeting:pickMedia が返した token */
  mediaToken?: string
  /** 文字起こし（ファイルから読んだ文か、貼り付けた文） */
  transcript?: { text: string; name?: string }
  /** レビューの名前（任意） */
  title?: string
}

export type MeetingImportStage = 'copy' | 'transcribe' | 'frames' | 'draft' | 'score'

export interface MeetingImportProgress {
  stage: MeetingImportStage
  /** 進んだ数と全体（分からなければ無し） */
  done?: number
  total?: number
}

/** 判定の結果（指摘ごと）。request は「具体的な依頼か」の P(true)、screen は「コマがその画面を写しているか」 */
export interface MeetingItemScore {
  request: number
  screen?: number
}

export interface MeetingScoreResult {
  /** 判定した数 */
  scored: number
  /** 判定モデルを使えなかった理由（無効・接続先が無いなど）。あれば点は付いていない */
  skipped?: string
  /** 送る対象から外した数（しきい値より低い） */
  excluded: number
}

/** 候補を送る対象に残す既定のしきい値（判定モデルの P(true)） */
export const MEETING_SCORE_THRESHOLD = 0.5

/** 判定に渡す、指摘1件の文 */
export interface MeetingDecisionSubject {
  title: string
  request: string
  quotes: Array<{ name?: string; text: string }>
}

/** 判定に渡す文の上限（文字数）。長い引用は切る */
const MAX_STATE_CHARS = 6000

/** System One の依頼の state（指摘と、そのもとの発話） */
export function meetingDecisionState(subject: MeetingDecisionSubject): string {
  const quotes = subject.quotes.map((q) => `- ${q.name ? `${q.name}: ` : ''}${q.text}`).join('\n')
  const state = [
    'A candidate finding extracted from a meeting transcript about a software product (website or app).',
    `Title: ${subject.title}`,
    `Request: ${subject.request}`,
    'What was said in the meeting:',
    quotes || '(no quotes)'
  ].join('\n')
  return state.length > MAX_STATE_CHARS ? `${state.slice(0, MAX_STATE_CHARS)}…` : state
}

/** 「具体的な依頼か」の問い（System One の noul） */
export const MEETING_REQUEST_QUESTION = {
  type: 'noul',
  instructions: 'Did the meeting participants ask for a concrete change to the product\'s screens or behavior that a developer could act on?',
  criteria: {
    true: 'The quotes ask for a specific change to what users see or how the product behaves (layout, copy, colors, flows, bugs to fix), and the change was wanted, not rejected.',
    false: 'Small talk, scheduling, status updates, questions without a requested change, ideas that were rejected or postponed, or topics unrelated to the product.'
  }
} as const

/** 「コマが話題の画面を写しているか」の問い（画像を読めるモデルで、コマがあるときだけ） */
export const MEETING_SCREEN_QUESTION = {
  type: 'noul',
  instructions: 'Does the image show the screen or part of the product that this finding is about?',
  criteria: {
    true: 'The image shows the product screen, page or element the finding talks about.',
    false: 'The image shows people, a blank or unrelated screen, or a different part of the product.'
  }
} as const

/** System One の依頼の本文。image は base64 か data URL（設定の渡し方にしたもの） */
export function meetingDecisionBody(model: string, subject: MeetingDecisionSubject, image?: string): Record<string, unknown> {
  return {
    model,
    state: meetingDecisionState(subject),
    questions: { request: MEETING_REQUEST_QUESTION, ...(image ? { screen: MEETING_SCREEN_QUESTION } : {}) },
    ...(image ? { images: [image] } : {})
  }
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const prob = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined)

/** 応答（System One。Cloudflare の { result } の包みも）から点を取る。読めなければ null */
export function meetingScoreFromAnswer(body: unknown): MeetingItemScore | null {
  const top = rec(body)
  const answers = rec(rec(top.result).answers ?? top.answers)
  const request = prob(rec(answers.request).noul)
  if (request === undefined) return null
  const screen = prob(rec(answers.screen).noul)
  return { request, ...(screen !== undefined ? { screen } : {}) }
}

/** 点を丸める（0.01 刻み。表示と保存の大きさのため） */
export function roundScore(score: MeetingItemScore): MeetingItemScore {
  const r = (n: number) => Math.round(n * 100) / 100
  return { request: r(score.request), ...(score.screen !== undefined ? { screen: r(score.screen) } : {}) }
}

/**
 * 点を指摘に付ける。setInclude なら、しきい値より低い指摘を送る対象から外し、届いた指摘は送る対象にする。
 * 点の付かなかった指摘はそのまま
 */
export function applyMeetingScores<T extends { id: string; include: boolean; meetingScore?: MeetingItemScore }>(
  items: readonly T[], scores: ReadonlyMap<string, MeetingItemScore>, threshold: number, setInclude: boolean
): { items: T[]; excluded: number } {
  let excluded = 0
  const next = items.map((item) => {
    const score = scores.get(item.id)
    if (!score) return item
    const include = setInclude ? score.request >= threshold : item.include
    if (setInclude && !include) excluded++
    return { ...item, meetingScore: roundScore(score), include }
  })
  return { items: next, excluded }
}

/**
 * コマを撮る時刻。発話の始まりを、間が minGapMs より近いものはまとめ、多すぎれば均等に間引く。
 * 時刻は動画の長さの中に収める
 */
export function meetingFrameTimes(starts: readonly number[], durationMs: number, max = 240, minGapMs = 15_000): number[] {
  const sorted = [...new Set(starts.filter((t) => Number.isFinite(t) && t >= 0).map((t) => Math.round(t)))].sort((a, b) => a - b)
  const picked: number[] = []
  for (const t of sorted) {
    // 話し始めの少し後（画面を切り替えた直後のことが多い）。動画の終わりを越えない
    const at = Math.max(0, Math.min(t + 1000, durationMs > 0 ? durationMs - 200 : t + 1000))
    if (picked.length === 0 || at - picked[picked.length - 1]! >= minGapMs) picked.push(at)
  }
  if (picked.length <= max) return picked
  const step = picked.length / max
  return Array.from({ length: max }, (_, i) => picked[Math.floor(i * step)]!)
}
