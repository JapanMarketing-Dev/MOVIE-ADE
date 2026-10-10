import { isSealedMemo, type SealedMemo, type ShareAuthVerifier } from './shareCrypto'

/**
 * ログイン無しで誰でも指摘を送れる「共有リンク」（workers/feedback-share）の仕様の正本。
 * Worker・相手の画面（workers/feedback-share/client）・アプリの main と renderer が同じ値と同じ検査を使う。
 *
 * 流れ:
 *   1. 持ち主（Ferret）が、見てほしいページの URL で共有を作る（ownerToken を受け取る）。メモとパスワードを付けられる
 *   2. リンク（https://share.ferretade.dev/s/<shareId>）を開いた人は、ログイン無しで、元のページをライブで開いて触りながら、
 *      アプリのフィードバックと同じ道具（ペン・枠・文字で指摘・声）で録画して送る。画面共有・端末の画面収録の動画も送れる（名前は任意）
 *   3. 同じリンクを開いた人は誰でも、届いた指摘（名前・時刻・文字の指摘・サムネイル・録画）を見られる
 *   4. 持ち主が届いた録画を取り込む・断る。取り込んだものは録画と同じ流れ（文字起こし・コマ・書き込み）で指摘になり、名前が付く
 *
 * 守り: shareId は 128 bit、ownerToken は 256 bit（Worker はハッシュだけを持つ）。パスワードは Worker へ届かない
 * （shareCrypto.ts。証明の SHA-256 だけを持つ）。共有と録画は7日で消える。
 */

export const SHARE_BASE = 'https://share.ferretade.dev'
/** 相手が開く画面のパス（/s/<shareId>） */
export const SHARE_PAGE_PREFIX = '/s/'

const MIB = 1024 * 1024

export const SHARE_LIMITS = {
  /** 共有の期限（日）。既定で、最長でもある */
  days: 7,
  titleChars: 120,
  /** ライブで開くページの数 */
  urls: 10,
  urlChars: 2000,
  pageTitleChars: 200,
  /** メモの字数（平文）と、暗号文（base64）の大きさ */
  memoChars: 4000,
  sealedMemoChars: 24_000,
  passwordMinChars: 6,
  passwordMaxChars: 128,
  /** 名前（任意） */
  nameChars: 50,
  /** 文字で指摘1件の字数と、1つの録画の中の数 */
  noteChars: 2000,
  notes: 100,
  /** 録画1本の大きさと長さ */
  recordingBytes: 300 * MIB,
  recordingMs: 10 * 60 * 1000,
  /** 送るときの1回の大きさ（R2 の multipart。最後以外は 5MiB 以上） */
  partBytes: 8 * MIB,
  /** 1つの共有で受け付ける録画の数と、合計の大きさ */
  recordings: 100,
  shareBytes: 3 * 1024 * MIB,
  /** 書き込み・文字で指摘・ページの操作の記録（JSON）の大きさと数 */
  eventsBytes: 512 * 1024,
  events: 5000,
  /** サムネイル（JPEG） */
  thumbnailBytes: 300 * 1024
} as const

/** 録画の種類。live … 元のページを開いて録画（Chrome・Edge は画面も、それ以外は声と書き込み）、screen … 画面共有、upload … 端末の画面収録の動画、notes … 文字の指摘だけ */
export type ShareRecordingMode = 'live' | 'screen' | 'upload' | 'notes'
export const SHARE_RECORDING_MODES: readonly ShareRecordingMode[] = ['live', 'screen', 'upload', 'notes']

/** 受け付ける録画の形式（中身の先頭のバイトでも確かめる。sniffMedia） */
export const SHARE_MEDIA_TYPES = {
  'video/webm': 'webm',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/mp4': 'm4a',
  'video/quicktime': 'mov'
} as const
export type ShareMediaType = keyof typeof SHARE_MEDIA_TYPES
export type ShareMediaExt = (typeof SHARE_MEDIA_TYPES)[ShareMediaType]

export interface ShareUrl {
  url: string
  title: string
}

/** メモ。パスワードのある共有は暗号文だけ（相手の画面とアプリが手元で復号する） */
export type ShareMemo = { kind: 'plain'; text: string } | { kind: 'sealed'; sealed: SealedMemo }

export type ShareRecordingStatus = 'new' | 'imported' | 'rejected'

/** 文字で指摘1件（録画の時計の ms） */
export interface ShareNote {
  t: number
  text: string
}

export interface ShareRecording {
  /** 16 進 16 文字 */
  id: string
  createdAt: string
  name?: string
  mode: ShareRecordingMode
  /** 媒体（notes のときは無い） */
  mime?: ShareMediaType
  bytes: number
  durationMs: number
  /** 映像がある（コマを撮れる） */
  hasVideo: boolean
  hasThumbnail: boolean
  /** 録画を始めたときのページ（ライブ） */
  startUrl?: string
  notes: ShareNote[]
  status: ShareRecordingStatus
}

/** 相手に見せる録画（状態は持ち主だけ。断ったものは出さない） */
export type SharePublicRecording = Omit<ShareRecording, 'status'>

/** 持ち主が受け取る共有の中身 */
export interface ShareSnapshot {
  id: string
  title: string
  createdAt: string
  expiresAt: string
  protected: boolean
  memo?: ShareMemo
  urls: ShareUrl[]
  recordings: ShareRecording[]
}

/** 相手が受け取る中身。パスワードのある共有は、確認が済むまで locked だけ */
export type SharePublicView =
  | { locked: true; salt: string; iterations: number }
  | { locked: false; id: string; title: string; expiresAt: string; protected: boolean; memo?: ShareMemo; urls: ShareUrl[]; recordings: SharePublicRecording[] }

/** アプリの画面に出す、作った共有の控え（持ち主のトークン・パスワードは含めない） */
export interface ShareSummaryInfo {
  id: string
  title: string
  url: string
  createdAt: string
  expiresAt: string
  urls: ShareUrl[]
  protected: boolean
  hasMemo: boolean
  /** パスワードをこの PC に覚えている（コピーできる） */
  hasPassword: boolean
}

/**
 * アプリの「共有の設定」で作る・変える値（画面 → main）。メモは平文のまま main へ渡し、パスワードがあれば main が暗号化して送る。
 * password: 文字列は「このパスワードにする」、null は「パスワードを外す」、省けば「変えない」（変えるときだけ）
 */
export interface ShareSettingsInput {
  title: string
  urls: ShareUrl[]
  memo: string
  password?: string | null
}

/** 設定の画面で開く値（パスワードそのものは返さない。覚えていればコピーだけできる） */
export interface ShareSettingsView {
  title: string
  urls: ShareUrl[]
  memo: string
  protected: boolean
  hasPassword: boolean
}

/**
 * パスワードの無い共有の注意。password はパスワードを付けるか（今の値・付ける予定のどちらでも）。
 *   'none' … パスワードあり（注意なし）
 *   'open' … パスワードなし（リンクを持つ人は誰でも見られる）
 *   'memo' … パスワードなしでメモがある（ログイン情報を書くならパスワードを付ける。強めに出す）
 */
export function sharePasswordAdvice(memo: string, password: boolean): 'none' | 'open' | 'memo' {
  if (password) return 'none'
  return memo.trim() ? 'memo' : 'open'
}

/** パスワードの長さを確かめる。合えば null、短すぎ・長すぎは理由 */
export function sharePasswordProblem(password: string): 'short' | 'long' | null {
  const length = [...password].length
  if (length < SHARE_LIMITS.passwordMinChars) return 'short'
  if (length > SHARE_LIMITS.passwordMaxChars) return 'long'
  return null
}

/** 共有の ID（128 bit）・録画の ID（64 bit） */
export const SHARE_ID_PATTERN = /^[0-9a-f]{32}$/
export const ITEM_ID_PATTERN = /^[0-9a-f]{16}$/
/** ownerToken（256 bit） */
export const OWNER_TOKEN_PATTERN = /^[0-9a-f]{64}$/
/** パスワードの証明（PBKDF2 の 256 bit） */
export const PROOF_PATTERN = /^[0-9a-f]{64}$/

export function shareUrl(shareId: string, base: string = SHARE_BASE): string {
  return `${base}${SHARE_PAGE_PREFIX}${shareId}`
}

/** 共有のリンクから ID を取り出す（貼られた URL・ID のどちらでも）。違えば null */
export function parseShareLink(text: string, base: string = SHARE_BASE): string | null {
  const value = text.trim()
  if (SHARE_ID_PATTERN.test(value)) return value
  const prefix = `${base}${SHARE_PAGE_PREFIX}`
  if (!value.startsWith(prefix)) return null
  const id = value.slice(prefix.length).replace(/[/?#].*$/, '')
  return SHARE_ID_PATTERN.test(id) ? id : null
}

/* ── 値の検査（Worker・相手の画面・アプリで同じものを使う） ─────────────────────── */

/** 制御文字（改行・タブ以外）を除き、前後の空白を落とす。長さは code point で数える。長すぎれば null */
export function cleanText(value: unknown, max: number, options: { multiline?: boolean } = {}): string | null {
  if (typeof value !== 'string' || value.length > max * 4) return null
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(options.multiline ? /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g : /[\u0000-\u001f\u007f\u2028\u2029]/g, '').replace(/\r\n?/g, '\n').trim()
  const chars = [...stripped]
  if (chars.length > max) return null
  return chars.join('')
}

/** http(s) の URL だけ（javascript: などを記録・表示しない）。長すぎれば null */
export function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > SHARE_LIMITS.urlChars) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** ライブで開くページの一覧を確かめる。1件以上・上限まで・http(s) だけ。合わなければ null */
export function sanitizeShareUrls(raw: unknown): ShareUrl[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SHARE_LIMITS.urls) return null
  const out: ShareUrl[] = []
  for (const item of raw) {
    const url = cleanUrl((item as { url?: unknown } | null)?.url)
    const title = cleanText((item as { title?: unknown } | null)?.title ?? '', SHARE_LIMITS.pageTitleChars)
    if (!url || title === null) return null
    out.push({ url, title })
  }
  return out
}

/** メモを確かめる。平文は上限まで、暗号文は形と大きさ。null は「メモなし」、undefined は形が違う */
export function sanitizeMemo(raw: unknown): ShareMemo | null | undefined {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as { kind?: unknown; text?: unknown; sealed?: unknown }
  if (m.kind === 'plain') {
    const text = cleanText(m.text, SHARE_LIMITS.memoChars, { multiline: true })
    if (text === null) return undefined
    return text ? { kind: 'plain', text } : null
  }
  if (m.kind === 'sealed' && isSealedMemo(m.sealed, SHARE_LIMITS.sealedMemoChars)) {
    const { v, iterations, salt, iv, data } = m.sealed
    return { kind: 'sealed', sealed: { v, iterations, salt, iv, data } }
  }
  return undefined
}

/** パスワードの確認の値（アプリが作る）。合わなければ undefined、null は「パスワードなし」 */
export function sanitizeAuthVerifier(raw: unknown): ShareAuthVerifier | null | undefined {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Record<string, unknown>
  if (typeof a.salt !== 'string' || !/^[A-Za-z0-9+/]{16,64}={0,2}$/.test(a.salt)) return undefined
  if (a.iterations !== 100_000 || typeof a.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(a.verifier)) return undefined
  return { salt: a.salt, iterations: a.iterations, verifier: a.verifier }
}

/** 相手が録画を始めるときに送る値 */
export interface ShareRecordingStart {
  name?: string
  mode: ShareRecordingMode
  mime?: ShareMediaType
  bytes: number
  durationMs: number
  hasVideo: boolean
  startUrl?: string
}

export function sanitizeRecordingStart(raw: unknown): ShareRecordingStart | { error: 'invalid' | 'too_long' | 'too_large' } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid' }
  const r = raw as Record<string, unknown>
  const allowed = new Set(['name', 'mode', 'mime', 'bytes', 'durationMs', 'hasVideo', 'startUrl', 'website'])
  if (Object.keys(r).some((k) => !allowed.has(k))) return { error: 'invalid' }
  if (typeof r.mode !== 'string' || !SHARE_RECORDING_MODES.includes(r.mode as ShareRecordingMode)) return { error: 'invalid' }
  const mode = r.mode as ShareRecordingMode
  const int = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
  if (!int(r.durationMs, SHARE_LIMITS.recordingMs + 5_000)) return { error: 'too_large' }
  if (typeof r.bytes !== 'number' || !Number.isInteger(r.bytes) || r.bytes < 0) return { error: 'invalid' }
  if (r.bytes > SHARE_LIMITS.recordingBytes) return { error: 'too_large' }
  let mime: ShareMediaType | undefined
  if (mode === 'notes') {
    if (r.bytes !== 0 || r.mime !== undefined) return { error: 'invalid' }
  } else {
    if (typeof r.mime !== 'string' || !Object.prototype.hasOwnProperty.call(SHARE_MEDIA_TYPES, r.mime) || r.bytes === 0) return { error: 'invalid' }
    mime = r.mime as ShareMediaType
  }
  let name: string | undefined
  if (r.name !== undefined && r.name !== '') {
    const n = cleanText(r.name, SHARE_LIMITS.nameChars)
    if (n === null) return { error: 'too_long' }
    if (n) name = n
  }
  let startUrl: string | undefined
  if (r.startUrl !== undefined) {
    const url = cleanUrl(r.startUrl)
    if (!url) return { error: 'invalid' }
    startUrl = url
  }
  return { mode, bytes: r.bytes, durationMs: r.durationMs as number, hasVideo: r.hasVideo === true && mode !== 'notes', ...(mime ? { mime } : {}), ...(name ? { name } : {}), ...(startUrl ? { startUrl } : {}) }
}

/** 文字で指摘の一覧（録画を送り終えるとき） */
export function sanitizeNotes(raw: unknown, durationMs: number): ShareNote[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > SHARE_LIMITS.notes) return null
  const out: ShareNote[] = []
  for (const item of raw) {
    const n = item as { t?: unknown; text?: unknown } | null
    const text = cleanText(n?.text, SHARE_LIMITS.noteChars, { multiline: true })
    if (typeof n?.t !== 'number' || !Number.isFinite(n.t) || text === null || !text) return null
    out.push({ t: Math.max(0, Math.min(durationMs, Math.round(n.t))), text })
  }
  return out
}

/* ── 書き込み・文字で指摘・ページの操作の記録（録画の時計の ms。座標は view の CSS ピクセル） ───────────── */

export type ShareBox = [number, number, number, number]

export type ShareEvent =
  /** 書き込み1本（アプリの録画の pen と同じ意味。動かした・戻したものは新しい ID で replaces に前の ID） */
  | { t: number; type: 'pen'; id: string; t_end: number; bbox: ShareBox; shape?: 'rect'; replaces?: string }
  | { t: number; type: 'erase'; ids: string[] }
  /** 文字で指摘（枠と文） */
  | { t: number; type: 'note'; id: string; bbox: ShareBox; text: string }
  /** 書き込む面の大きさが変わった */
  | { t: number; type: 'view'; width: number; height: number }

export interface ShareEventsFile {
  v: 1
  /** 録画を始めたときの書き込む面の大きさ（CSS ピクセル） */
  view: { width: number; height: number }
  events: ShareEvent[]
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,40}$/
const MAX_COORD = 20_000

function box(raw: unknown): ShareBox | null {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, w, h] = (raw as number[]).map((n) => Math.round(Math.max(-MAX_COORD, Math.min(MAX_COORD, n))))
  return w! > 0 && h! > 0 ? [x!, y!, w!, h!] : null
}

function size(raw: unknown): { width: number; height: number } | null {
  const s = raw as { width?: unknown; height?: unknown } | null
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_COORD
  return s && ok(s.width) && ok(s.height) ? { width: s.width, height: s.height } : null
}

/** 記録の JSON を確かめる。知らない種類・形の違う項目は捨てる。全体の形が違えば null */
export function sanitizeEventsFile(raw: unknown, durationMs: number): ShareEventsFile | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { v?: unknown; view?: unknown; events?: unknown }
  const view = size(r.view)
  if (r.v !== 1 || !view || !Array.isArray(r.events) || r.events.length > SHARE_LIMITS.events) return null
  const clampT = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(durationMs, Math.round(n))) : null)
  const events: ShareEvent[] = []
  for (const item of r.events as unknown[]) {
    const e = (item ?? {}) as Record<string, unknown>
    const t = clampT(e.t)
    if (t === null) continue
    if (e.type === 'pen' && typeof e.id === 'string' && EVENT_ID.test(e.id)) {
      const b = box(e.bbox)
      const tEnd = clampT(e.t_end) ?? t
      if (!b) continue
      events.push({ t, type: 'pen', id: e.id, t_end: Math.max(t, tEnd), bbox: b,
        ...(e.shape === 'rect' ? { shape: 'rect' as const } : {}),
        ...(typeof e.replaces === 'string' && EVENT_ID.test(e.replaces) ? { replaces: e.replaces } : {}) })
    } else if (e.type === 'erase' && Array.isArray(e.ids) && e.ids.length <= 100 && e.ids.every((id) => typeof id === 'string' && EVENT_ID.test(id))) {
      events.push({ t, type: 'erase', ids: e.ids as string[] })
    } else if (e.type === 'note' && typeof e.id === 'string' && EVENT_ID.test(e.id)) {
      const b = box(e.bbox)
      const text = cleanText(e.text, SHARE_LIMITS.noteChars, { multiline: true })
      if (b && text) events.push({ t, type: 'note', id: e.id, bbox: b, text })
    } else if (e.type === 'view') {
      const s = size(e)
      if (s) events.push({ t, type: 'view', ...s })
    }
  }
  return { v: 1, view, events }
}

/** 媒体の中身の先頭のバイトで形式を見分ける（webm は EBML、mp4・mov・m4a は ftyp）。合わなければ null */
export function sniffMedia(head: Uint8Array): 'webm' | 'iso' | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm'
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return 'iso'
  return null
}

/** 宣言した形式と中身が合うか */
export function mediaMatches(mime: ShareMediaType, head: Uint8Array): boolean {
  const kind = sniffMedia(head)
  return SHARE_MEDIA_TYPES[mime] === 'webm' ? kind === 'webm' : kind === 'iso'
}

/** 失敗の code（Worker が返す。画面の文は code から選ぶ） */
export const SHARE_ERROR_STATUS = {
  invalid_request: 400,
  empty: 400,
  too_long: 400,
  too_large: 413,
  bad_media: 415,
  bad_image: 415,
  unauthorized: 401,
  locked: 401,
  wrong_password: 403,
  origin_not_allowed: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  gone: 410,
  full: 409,
  rate_limited: 429,
  internal: 500
} as const

export type ShareErrorCode = keyof typeof SHARE_ERROR_STATUS
