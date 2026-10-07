/**
 * ログイン無しで誰でも指摘を送れる「共有リンク」（workers/feedback-share）の仕様の正本。
 * Worker・アプリの main・renderer が同じ値と同じ検査を使う（形を変えるときはここだけを直す）。
 *
 * 流れ:
 *   1. 持ち主（Ferret）が共有を作り（ownerToken を受け取る）、内蔵ブラウザで撮ったページの静止画を足す
 *   2. リンク（https://share.ferretade.dev/s/<shareId>）を受け取った人が、ログイン無しで静止画に注釈を打って文を送る（名前は任意）
 *   3. 持ち主が一覧を取り、取り込む／断る。取り込んだものは Ferret の指摘（レビュー）になり、BEFORE/AFTER の確認に乗る
 *
 * 守り: shareId は推測できない 128 bit、ownerToken は 256 bit（Worker はハッシュだけを持つ）。
 * 持ち主の操作は Authorization: Bearer で送り、URL のクエリに秘密を載せない。相手の送信は大きさ・数・頻度に上限を持つ。
 */

export const SHARE_BASE = 'https://share.ferretade.dev'
/** 相手が開く画面のパス（/s/<shareId>） */
export const SHARE_PAGE_PREFIX = '/s/'

export const SHARE_LIMITS = {
  /** 共有の題名 */
  titleChars: 120,
  /** 1つの共有のページ数 */
  pages: 20,
  /** ページの題名・URL */
  pageTitleChars: 200,
  urlChars: 2000,
  /** ページの静止画（PNG / JPEG） */
  imageBytes: 4 * 1024 * 1024,
  /** 1つの共有で受け付ける指摘の数（断ったものも数える） */
  comments: 500,
  /** 名前（任意） */
  nameChars: 50,
  /** 本文 */
  textChars: 2000,
  /** ペンの点の数 */
  penPoints: 200,
  /** 指摘の送信の本文（JSON）の大きさ */
  commentRequestBytes: 32 * 1024,
  /** 共有の期限（日）の既定と上限 */
  defaultDays: 30,
  maxDays: 90
} as const

export type ShareViewport = 'desktop' | 'mobile'

export interface SharePage {
  /** 共有の中の ID（16 進 16 文字） */
  id: string
  url: string
  title: string
  viewport: ShareViewport
  /** 静止画の CSS ピクセルの大きさ */
  width: number
  height: number
  /** 静止画の拡張子 */
  ext: 'png' | 'jpg'
}

/** 注釈の形。座標は静止画（ライブのときは画面）の幅・高さに対する 0..1 */
export type ShareShape =
  | { kind: 'pin'; x: number; y: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'pen'; points: Array<[number, number]> }

export type ShareCommentStatus = 'new' | 'imported' | 'rejected'

export interface ShareComment {
  /** 16 進 16 文字 */
  id: string
  pageId: string
  createdAt: string
  /** 名前（任意） */
  name?: string
  text: string
  shape?: ShareShape
  /** ライブ（元のページを開いた状態）で打った。そのとき見ていた URL（分かれば） */
  live?: { url: string }
  /** 打ったときの表示の幅（CSS ピクセル） */
  viewWidth?: number
  status: ShareCommentStatus
}

/** 持ち主が受け取る共有の中身 */
export interface ShareSnapshot {
  id: string
  title: string
  createdAt: string
  expiresAt: string
  /** 相手どうしでほかの人の指摘が見える */
  showOthers: boolean
  pages: SharePage[]
  comments: ShareComment[]
}

/** アプリの画面に出す、作った共有の控え（持ち主のトークンは含めない。トークンは main だけが持つ） */
export interface ShareSummaryInfo {
  id: string
  title: string
  url: string
  createdAt: string
  expiresAt: string
}

/** 相手（ログイン無し）が受け取る中身。ほかの人の指摘は showOthers のときだけ、断ったものは除く */
export interface SharePublicView {
  id: string
  title: string
  expiresAt: string
  showOthers: boolean
  pages: SharePage[]
  comments: Array<Pick<ShareComment, 'id' | 'pageId' | 'createdAt' | 'name' | 'text' | 'shape'>>
}

/** 共有の ID（128 bit）・ページと指摘の ID（64 bit） */
export const SHARE_ID_PATTERN = /^[0-9a-f]{32}$/
export const ITEM_ID_PATTERN = /^[0-9a-f]{16}$/
/** ownerToken（256 bit） */
export const OWNER_TOKEN_PATTERN = /^[0-9a-f]{64}$/

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

/* ── 値の検査（Worker とアプリで同じものを使う） ─────────────────────── */

/** 制御文字（改行・タブ以外）を除き、前後の空白を落とす。長さは code point で数える */
export function cleanText(value: unknown, max: number, options: { multiline?: boolean } = {}): string | null {
  if (typeof value !== 'string' || value.length > max * 4) return null
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(options.multiline ? /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g : /[\u0000-\u001f\u007f\u2028\u2029]/g, '').replace(/\r\n?/g, '\n').trim()
  const chars = [...stripped]
  if (chars.length > max) return null
  return chars.join('')
}

const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
const round = (n: number) => Math.round(n * 10_000) / 10_000

/** 注釈の形を確かめる。座標は 0..1 に限り、小数4桁に丸める。合わなければ null */
export function sanitizeShape(raw: unknown): ShareShape | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.kind === 'pin' && unit(s.x) && unit(s.y)) return { kind: 'pin', x: round(s.x), y: round(s.y) }
  if (s.kind === 'rect' && unit(s.x) && unit(s.y) && unit(s.w) && unit(s.h) && s.w > 0 && s.h > 0 && s.x + s.w <= 1.0001 && s.y + s.h <= 1.0001) {
    return { kind: 'rect', x: round(s.x), y: round(s.y), w: round(s.w), h: round(s.h) }
  }
  if (s.kind === 'pen' && Array.isArray(s.points) && s.points.length >= 2 && s.points.length <= SHARE_LIMITS.penPoints) {
    const points: Array<[number, number]> = []
    for (const p of s.points) {
      if (!Array.isArray(p) || p.length !== 2 || !unit(p[0]) || !unit(p[1])) return null
      points.push([round(p[0]), round(p[1])])
    }
    return { kind: 'pen', points }
  }
  return null
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

/** 相手が送る指摘（POST /v1/public/<id>/comments の本文） */
export interface ShareCommentInput {
  pageId: string
  name?: string
  text: string
  shape?: ShareShape
  live?: { url: string }
  viewWidth?: number
}

/** 相手の送信を確かめる。ページの ID は呼び出し側が共有の中にあるかを確かめる。合わなければ理由 */
export function sanitizeCommentInput(raw: unknown): ShareCommentInput | { error: 'invalid' | 'empty' | 'too_long' } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid' }
  const r = raw as Record<string, unknown>
  const allowed = new Set(['pageId', 'name', 'text', 'shape', 'live', 'viewWidth', 'website'])
  if (Object.keys(r).some((k) => !allowed.has(k))) return { error: 'invalid' }
  if (typeof r.pageId !== 'string' || !ITEM_ID_PATTERN.test(r.pageId)) return { error: 'invalid' }
  if (typeof r.text !== 'string') return { error: 'invalid' }
  const text = cleanText(r.text, SHARE_LIMITS.textChars, { multiline: true })
  if (text === null) return { error: 'too_long' }
  if (!text) return { error: 'empty' }
  let name: string | undefined
  if (r.name !== undefined && r.name !== '') {
    const n = cleanText(r.name, SHARE_LIMITS.nameChars)
    if (n === null) return { error: 'too_long' }
    if (n) name = n
  }
  let shape: ShareShape | undefined
  if (r.shape !== undefined && r.shape !== null) {
    const s = sanitizeShape(r.shape)
    if (!s) return { error: 'invalid' }
    shape = s
  }
  let live: { url: string } | undefined
  if (r.live !== undefined && r.live !== null) {
    const url = cleanUrl((r.live as { url?: unknown } | null)?.url)
    if (!url) return { error: 'invalid' }
    live = { url }
  }
  const viewWidth = typeof r.viewWidth === 'number' && Number.isInteger(r.viewWidth) && r.viewWidth > 0 && r.viewWidth <= 10_000 ? r.viewWidth : undefined
  return { pageId: r.pageId, text, ...(name ? { name } : {}), ...(shape ? { shape } : {}), ...(live ? { live } : {}), ...(viewWidth ? { viewWidth } : {}) }
}

/**
 * 形を、静止画のピクセルの枠 [x, y, w, h] にする（Ferret の指摘の枠。文字で指摘と同じ形）。
 * ピンはまわりの小さな枠、ペンは点を囲む枠。どれも静止画からはみ出さないように詰める
 */
export function shapeToBox(shape: ShareShape | undefined, width: number, height: number): [number, number, number, number] {
  const clampBox = (x: number, y: number, w: number, h: number): [number, number, number, number] => {
    // 両端をそれぞれ静止画の中へ詰める（端からはみ出した分は枠から削る）
    const x0 = Math.max(0, Math.min(width - 1, Math.round(x)))
    const y0 = Math.max(0, Math.min(height - 1, Math.round(y)))
    const x1 = Math.max(x0 + 1, Math.min(width, Math.round(x + w)))
    const y1 = Math.max(y0 + 1, Math.min(height, Math.round(y + h)))
    return [x0, y0, x1 - x0, y1 - y0]
  }
  if (!shape) return clampBox(0, 0, width, height)
  if (shape.kind === 'rect') return clampBox(shape.x * width, shape.y * height, shape.w * width, shape.h * height)
  if (shape.kind === 'pin') {
    const r = Math.max(24, Math.round(Math.min(width, height) * 0.04))
    return clampBox(shape.x * width - r, shape.y * height - r, r * 2, r * 2)
  }
  const xs = shape.points.map((p) => p[0] * width)
  const ys = shape.points.map((p) => p[1] * height)
  const pad = 8
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  return clampBox(minX, minY, Math.max(...xs) + pad - minX, Math.max(...ys) + pad - minY)
}

/** 取り込んだ指摘の文（名前があれば先頭に付ける。ライブで別の URL を見ていたら添える） */
export function commentNoteText(comment: Pick<ShareComment, 'name' | 'text' | 'live'>, page?: Pick<SharePage, 'url'>): string {
  const lines = [comment.name ? `${comment.name}: ${comment.text}` : comment.text]
  if (comment.live && comment.live.url !== page?.url) lines.push(`(${comment.live.url})`)
  return lines.join('\n')
}

/** 失敗の code（Worker が返す。画面の文はアプリが code から選ぶ） */
export const SHARE_ERROR_STATUS = {
  invalid_request: 400,
  empty: 400,
  too_long: 400,
  too_large: 413,
  bad_image: 415,
  unauthorized: 401,
  origin_not_allowed: 403,
  not_found: 404,
  method_not_allowed: 405,
  gone: 410,
  full: 409,
  rate_limited: 429,
  internal: 500
} as const

export type ShareErrorCode = keyof typeof SHARE_ERROR_STATUS
