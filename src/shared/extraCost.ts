/**
 * Agent の会話の記録の外のコスト（インフラ・外部サービス・AI のサブスクリプションなど）。全体のダッシュボードで、
 * 会話の記録から数えたコスト（@shared/agentCost）と合わせて今月・今年・総額と内訳に出す。
 *
 * 置き場は各プロダクトのフォルダと全体のフォルダの `.ferret/costs.json`（Agent への依頼「すべてのコストを記録する」で Agent が書く）。
 *   { "items": [
 *     { "name": "Cloudflare Workers Paid", "category": "infra", "monthlyUsd": 5, "since": "2026-01", "until": "2026-09" },
 *     { "name": "example.com domain", "category": "infra", "usd": 12, "date": "2026-03-01", "estimate": true }
 *   ] }
 * 毎月のものは since の月から until の月（無ければ今月）まで毎月かかったとして数える。1回きりのものは date の時刻で数える。
 * 画面に依存しない純粋な処理だけを置く（読むのは src/main/orchestraOverview.ts）
 */

import type { CostPeriod } from './agentCost'

export const COST_CATEGORIES = ['infra', 'service', 'ai', 'other'] as const
export type CostCategory = (typeof COST_CATEGORIES)[number]

export interface CostEntry {
  name: string
  category: CostCategory
  /** 毎月の額（USD） */
  monthlyUsd?: number
  /** 毎月のものの始まりと終わり（YYYY-MM。until が無ければ今も続く） */
  since?: string
  until?: string
  /** 1回きりの額（USD）と日付（YYYY-MM-DD） */
  usd?: number
  date?: string
  /** 見積もり（料金表からの推定） */
  estimate?: boolean
}

export interface ExtraTotals {
  usd: number
  byCategory: Record<CostCategory, number>
  /** 名前ごとの額（内訳。同じ名前は足す） */
  items: Record<string, number>
  /** 見積もりを含む */
  estimated: boolean
}

export type ExtraPeriods = Record<CostPeriod, ExtraTotals>

const EMPTY_CATEGORIES: Record<CostCategory, number> = { infra: 0, service: 0, ai: 0, other: 0 }
export const EMPTY_EXTRA: ExtraTotals = { usd: 0, byCategory: EMPTY_CATEGORIES, items: {}, estimated: false }
export const EMPTY_EXTRA_PERIODS: ExtraPeriods = { month: EMPTY_EXTRA, year: EMPTY_EXTRA, total: EMPTY_EXTRA }

const MAX_ENTRIES = 300
const MAX_USD = 10_000_000
const MONTH_RE = /^(\d{4})-(\d{2})$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function amount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_USD ? v : undefined
}

function monthOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const m = MONTH_RE.exec(v.trim().slice(0, 7))
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : undefined
}

/** costs.json の中身を確かめる。壊れた行・額の無い行は捨てる */
export function parseCostFile(raw: unknown): CostEntry[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : Array.isArray(raw) ? raw : []
  return list.slice(0, MAX_ENTRIES).flatMap((item): CostEntry[] => {
    if (!item || typeof item !== 'object') return []
    const i = item as Record<string, unknown>
    const name = typeof i.name === 'string' ? i.name.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (!name) return []
    const category = (COST_CATEGORIES as readonly string[]).includes(i.category as string) ? i.category as CostCategory : 'other'
    const monthlyUsd = amount(i.monthlyUsd)
    const usd = amount(i.usd)
    const date = typeof i.date === 'string' && DATE_RE.test(i.date.trim()) ? i.date.trim() : undefined
    const estimate = i.estimate === true ? { estimate: true } : {}
    if (monthlyUsd !== undefined) {
      const since = monthOf(i.since)
      const until = monthOf(i.until)
      return [{ name, category, monthlyUsd, ...(since ? { since } : {}), ...(until ? { until } : {}), ...estimate }]
    }
    if (usd !== undefined && date) return [{ name, category, usd, date, ...estimate }]
    return []
  })
}

/** 月の通し番号（年×12＋月）。比べやすくする */
function monthIndex(year: number, month1: number): number {
  return year * 12 + (month1 - 1)
}

function parseMonth(v: string): number {
  const m = MONTH_RE.exec(v)!
  return monthIndex(Number(m[1]), Number(m[2]))
}

/** 毎月のものが [from, to] の月（両端を含む）にかかった月の数 */
function activeMonths(entry: CostEntry, from: number, to: number): number {
  const start = entry.since ? parseMonth(entry.since) : to
  const end = Math.min(entry.until ? parseMonth(entry.until) : to, to)
  const lo = Math.max(start, from)
  return end >= lo ? end - lo + 1 : 0
}

function add(t: ExtraTotals, entry: CostEntry, usd: number): ExtraTotals {
  if (usd <= 0) return t
  return {
    usd: t.usd + usd,
    byCategory: { ...t.byCategory, [entry.category]: t.byCategory[entry.category] + usd },
    items: { ...t.items, [entry.name]: (t.items[entry.name] ?? 0) + usd },
    estimated: t.estimated || entry.estimate === true
  }
}

/** 今月・今年・総額に分ける（手元の時刻。未来の日付の1回きりのものは数えない） */
export function extraPeriods(entries: readonly CostEntry[], now: number): ExtraPeriods {
  const d = new Date(now)
  const thisMonth = monthIndex(d.getFullYear(), d.getMonth() + 1)
  const yearStart = monthIndex(d.getFullYear(), 1)
  let out = EMPTY_EXTRA_PERIODS
  for (const e of entries) {
    if (e.monthlyUsd !== undefined) {
      out = {
        month: add(out.month, e, e.monthlyUsd * activeMonths(e, thisMonth, thisMonth)),
        year: add(out.year, e, e.monthlyUsd * activeMonths(e, yearStart, thisMonth)),
        total: add(out.total, e, e.monthlyUsd * activeMonths(e, Number.MIN_SAFE_INTEGER, thisMonth))
      }
      continue
    }
    if (e.usd === undefined || !e.date) continue
    const m = DATE_RE.exec(e.date)!
    const at = monthIndex(Number(m[1]), Number(m[2]))
    if (at > thisMonth) continue
    out = {
      month: at === thisMonth ? add(out.month, e, e.usd) : out.month,
      year: at >= yearStart ? add(out.year, e, e.usd) : out.year,
      total: add(out.total, e, e.usd)
    }
  }
  return out
}

export function sumExtra(list: readonly ExtraTotals[]): ExtraTotals {
  return list.reduce((acc, t) => {
    const items = { ...acc.items }
    for (const [k, v] of Object.entries(t.items)) items[k] = (items[k] ?? 0) + v
    const byCategory = { ...acc.byCategory }
    for (const c of COST_CATEGORIES) byCategory[c] += t.byCategory[c]
    return { usd: acc.usd + t.usd, byCategory, items, estimated: acc.estimated || t.estimated }
  }, EMPTY_EXTRA)
}
