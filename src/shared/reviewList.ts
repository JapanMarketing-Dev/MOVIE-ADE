/**
 * サイドバーのレビュー履歴の一覧（フィルタ・並び替え・見出し）。
 * Electron と React に依存しない純粋な処理だけを置く（renderer と単体テストで使う）。
 *
 * 試しの録画（指摘0件の下書き）が並ぶと、時刻とホストだけではどれがどれか分からない。
 * 既定では指摘0件の下書きとアーカイブを隠し、検索・状態・対象のホストで絞れるようにする。
 */

export type ReviewStatus = 'draft' | 'sent' | 'incomplete' | 'broken'

/** フィルタで選べる状態。開けない（broken）は「未完了」に含める */
export type ReviewStatusFilter = 'draft' | 'sent' | 'incomplete'
export const REVIEW_STATUS_FILTERS: readonly ReviewStatusFilter[] = ['draft', 'sent', 'incomplete']

/** 一覧の1件のうち、フィルタと並び替えに使うところ */
export interface ReviewListEntry {
  id: string
  status: ReviewStatus
  findings: number
  /** 進み具合（Agent へ送る指摘のうち完了した数と対象の数）。送る指摘が無ければ無い */
  progress?: { done: number; total: number; needsHuman?: number; humanReview?: number }
  /** 対象のURL（無ければ見出し用の文） */
  target: string
  /** 収録開始（ISO8601）。無ければ並びを変えない */
  startedAt?: string
  title?: string
  name?: string
  /** 指摘から自動で付けた名前（何系の修正か） */
  autoName?: string
  archived?: boolean
  searchText?: string
}

export interface ReviewFilter {
  /** 空白で区切った語をすべて含むものだけ（大文字小文字は区別しない） */
  query: string
  /** 空なら全部 */
  statuses: ReviewStatusFilter[]
  /** 指摘0件の下書きを隠す（既定 true） */
  hideEmpty: boolean
  /** アーカイブしたものも出す */
  showArchived: boolean
  /** 対象のホスト。null なら全部 */
  host: string | null
}

export const DEFAULT_REVIEW_FILTER: ReviewFilter = { query: '', statuses: [], hideEmpty: true, showArchived: false, host: null }

/** 保存していた値を型どおりに直す（localStorage から読む。壊れていれば既定） */
export function sanitizeReviewFilter(raw: unknown): ReviewFilter {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_REVIEW_FILTER }
  const r = raw as Partial<Record<keyof ReviewFilter, unknown>>
  return {
    query: typeof r.query === 'string' ? r.query.slice(0, 200) : '',
    statuses: Array.isArray(r.statuses) ? REVIEW_STATUS_FILTERS.filter((s) => (r.statuses as unknown[]).includes(s)) : [],
    hideEmpty: r.hideEmpty !== false,
    showArchived: r.showArchived === true,
    host: typeof r.host === 'string' && r.host.length > 0 ? r.host : null
  }
}

/** 既定から変えているか（「絞り込み中」の印に使う。検索語は別に見せるので数えない） */
export function isFilterActive(filter: ReviewFilter): boolean {
  return filter.statuses.length > 0 || !filter.hideEmpty || filter.showArchived || filter.host !== null
}

export function statusGroup(status: ReviewStatus): ReviewStatusFilter {
  return status === 'broken' ? 'incomplete' : status
}

/** 指摘0件の下書き（試しの録画）。まとめて片付ける対象 */
export function isEmptyDraft(entry: ReviewListEntry): boolean {
  return entry.status === 'draft' && entry.findings === 0
}

/**
 * 対象のホスト。http(s) はホスト（ポート込み）、それ以外のURLはスキーム（ade-preview: など）。
 * URLでなければ空文字（＝ホストなし）。
 */
export function reviewHost(target: string): string {
  try {
    const url = new URL(target)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host
    return url.protocol
  } catch {
    return ''
  }
}

/** 一覧の見出し。付けた名前 → 自動の名前 → ページのタイトル → URLのパス → ホスト → 対象の文 の順 */
export function reviewHeading(entry: ReviewListEntry): string {
  if (entry.name) return entry.name
  if (entry.autoName) return entry.autoName
  if (entry.title) return entry.title
  try {
    const url = new URL(entry.target)
    const path = decodeURIComponent(url.pathname)
    if (path && path !== '/') return path
    return url.host || entry.target
  } catch {
    return entry.target
  }
}

export function filterReviews<T extends ReviewListEntry>(entries: readonly T[], filter: ReviewFilter): T[] {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((entry) => {
    if (entry.archived && !filter.showArchived) return false
    if (filter.hideEmpty && isEmptyDraft(entry)) return false
    if (filter.statuses.length > 0 && !filter.statuses.includes(statusGroup(entry.status))) return false
    if (filter.host !== null && reviewHost(entry.target) !== filter.host) return false
    if (terms.length > 0) {
      const haystack = [entry.name, entry.autoName, entry.title, entry.target, entry.searchText].filter(Boolean).join('\n').toLowerCase()
      if (!terms.every((term) => haystack.includes(term))) return false
    }
    return true
  })
}

/** 新しい順。収録開始が無いものは元の並びのまま後ろへ */
export function sortReviews<T extends ReviewListEntry>(entries: readonly T[]): T[] {
  const time = (entry: T) => (entry.startedAt ? Date.parse(entry.startedAt) : Number.NaN)
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ta = time(a.entry)
      const tb = time(b.entry)
      if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.isNaN(ta) === Number.isNaN(tb) ? a.index - b.index : Number.isNaN(ta) ? 1 : -1
      return tb - ta || (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0)
    })
    .map(({ entry }) => entry)
}

/** フィルタに出すホストの一覧。件数の多い順（同数ならホスト名順） */
export function reviewHosts(entries: readonly ReviewListEntry[]): Array<{ host: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const host = reviewHost(entry.target)
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
}

/** 録画の長さ「1:05」「1:02:03」。0 や不明なら空文字 */
export function formatReviewDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.max(1, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
