/**
 * インフラのコスト（AWS・Cloudflare・Google Cloud などのクラウド・ドメイン・外部サービス）。全体のダッシュボードで、
 * 実際にかかった額（今月・今年・総額）と、今動いているリソースから見た推定の月額を、プロダクト・事業者・費目・項目の内訳で出す。
 * AI（Agent のサブスクリプション・API）はサブスクで払っているので数えない（category が ai のものは読み飛ばす）。
 *
 * 置き場は各プロダクトのフォルダと全体のフォルダの `.ferret/costs.json`（Agent への依頼「インフラのコストを記録する」で Agent が書く）。
 *   { "items": [
 *       { "name": "Cloudflare Workers Paid", "provider": "Cloudflare", "category": "infra", "monthlyUsd": 5, "since": "2026-01", "until": "2026-09" },
 *       { "name": "AWS 2026-09 bill", "provider": "AWS", "category": "infra", "usd": 41.2, "date": "2026-09-30" },
 *       { "name": "example.com domain", "provider": "Cloudflare", "category": "infra", "usd": 12, "date": "2026-03-01", "estimate": true }
 *     ],
 *     "checkedAt": "2026-10-10",
 *     "estimates": [
 *       { "name": "EC2 t3.small ×2 (ap-northeast-1)", "provider": "AWS", "monthlyUsd": 30.4, "basis": "$0.0208/h × 730h × 2" }
 *     ] }
 * items は実績。毎月のものは since の月から until の月（無ければ今月）まで毎月かかったとして数える。1回きりのものは date の月で数える。
 * estimates は今動いているリソース（インスタンス・DB・ストレージ・ドメインなど）を料金表で月額にしたもの。checkedAt はそれを調べた日。
 * estimates の無いフォルダは、今も続いている毎月の items を推定の月額にする。
 * 画面に依存しない純粋な処理だけを置く（読むのは src/main/orchestraOverview.ts）
 */

export type CostPeriod = 'month' | 'year' | 'total'
export const COST_PERIODS: readonly CostPeriod[] = ['month', 'year', 'total']

/** costs.json に書ける費目。ai は書かれていても数えない */
const FILE_CATEGORIES = ['infra', 'service', 'ai', 'other'] as const
export const COST_CATEGORIES = ['infra', 'service', 'other'] as const
export type CostCategory = (typeof COST_CATEGORIES)[number]

export interface CostEntry {
  name: string
  category: CostCategory
  /** 事業者（AWS・Cloudflare・Google Cloud など。分からなければ空） */
  provider: string
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

/** 今動いているリソースの推定の月額 */
export interface CostEstimate {
  name: string
  provider: string
  monthlyUsd: number
  /** 計算の元（単価 × 時間 × 台数など） */
  basis?: string
}

export interface CostFile {
  items: CostEntry[]
  /** estimates が書かれていなければ null（毎月の items から推定する） */
  estimates: CostEstimate[] | null
  checkedAt: string | null
}

export interface ExtraTotals {
  usd: number
  byCategory: Record<CostCategory, number>
  /** 事業者ごと（分からないものは空の名前） */
  byProvider: Record<string, number>
  /** 名前ごとの額（内訳。同じ名前は足す） */
  items: Record<string, number>
  /** 見積もりを含む */
  estimated: boolean
}

export type ExtraPeriods = Record<CostPeriod, ExtraTotals>

/** 今のリソースから見た推定の月額 */
export interface CostForecast {
  usd: number
  byProvider: Record<string, number>
  items: Record<string, number>
  /** 項目ごとの計算の元 */
  basis: Record<string, string>
  /** 調べた日のうち一番古いもの（無ければ null） */
  checkedAt: string | null
  /** estimates が無く、毎月の items から出したものを含む */
  fromRecurring: boolean
}

const EMPTY_CATEGORIES: Record<CostCategory, number> = { infra: 0, service: 0, other: 0 }
export const EMPTY_EXTRA: ExtraTotals = { usd: 0, byCategory: EMPTY_CATEGORIES, byProvider: {}, items: {}, estimated: false }
export const EMPTY_EXTRA_PERIODS: ExtraPeriods = { month: EMPTY_EXTRA, year: EMPTY_EXTRA, total: EMPTY_EXTRA }
export const EMPTY_FORECAST: CostForecast = { usd: 0, byProvider: {}, items: {}, basis: {}, checkedAt: null, fromRecurring: false }

const MAX_ENTRIES = 300
const MAX_USD = 10_000_000
const MONTH_RE = /^(\d{4})-(\d{2})$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** よく使う事業者の名前をそろえる（書き方の揺れ・名前からの推測） */
const PROVIDERS: ReadonlyArray<{ match: RegExp; name: string }> = [
  { match: /\b(aws|amazon|ec2|s3|rds|lambda|cloudfront|route ?53|lightsail)\b/i, name: 'AWS' },
  { match: /cloudflare|\bworkers\b|\br2\b|\bd1\b/i, name: 'Cloudflare' },
  { match: /\b(gcp|google cloud|cloud run|firebase|bigquery|gce|cloud sql)\b/i, name: 'Google Cloud' },
  { match: /\b(azure|microsoft)\b/i, name: 'Azure' },
  { match: /\bvercel\b/i, name: 'Vercel' },
  { match: /\bnetlify\b/i, name: 'Netlify' },
  { match: /\bfly\.io\b|\bfly io\b/i, name: 'Fly.io' },
  { match: /\brender\.com\b/i, name: 'Render' },
  { match: /\bsupabase\b/i, name: 'Supabase' },
  { match: /\bneon\b/i, name: 'Neon' },
  { match: /\bdigitalocean\b/i, name: 'DigitalOcean' },
  { match: /\bhetzner\b/i, name: 'Hetzner' },
  { match: /\bsentry\b/i, name: 'Sentry' },
  { match: /\bgithub\b/i, name: 'GitHub' }
]

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** 書かれた事業者をそろえる。無ければ名前から推測し、分からなければ空 */
export function providerOf(provider: unknown, name: string): string {
  const given = text(provider, 40)
  const known = PROVIDERS.find((p) => p.match.test(given || name))
  return known ? known.name : given
}

function amount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_USD ? v : undefined
}

function monthOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const m = MONTH_RE.exec(v.trim().slice(0, 7))
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : undefined
}

function dateOf(v: unknown): string | null {
  return typeof v === 'string' && DATE_RE.test(v.trim()) ? v.trim() : null
}

function isAi(i: Record<string, unknown>): boolean {
  return i.category === 'ai'
}

/** costs.json の中身を確かめる。壊れた行・額の無い行・AI の行は捨てる */
export function parseCostFile(raw: unknown): CostEntry[] {
  return parseCosts(raw).items
}

export function parseCosts(raw: unknown): CostFile {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const list = Array.isArray(obj.items) ? obj.items : Array.isArray(raw) ? raw : []
  const items = list.slice(0, MAX_ENTRIES).flatMap((item): CostEntry[] => {
    if (!item || typeof item !== 'object') return []
    const i = item as Record<string, unknown>
    const name = text(i.name, 80)
    if (!name || isAi(i)) return []
    const category = (FILE_CATEGORIES as readonly string[]).includes(i.category as string) ? i.category as CostCategory : 'other'
    const provider = providerOf(i.provider, name)
    const monthlyUsd = amount(i.monthlyUsd)
    const usd = amount(i.usd)
    const date = dateOf(i.date)
    const estimate = i.estimate === true ? { estimate: true } : {}
    if (monthlyUsd !== undefined) {
      const since = monthOf(i.since)
      const until = monthOf(i.until)
      return [{ name, category, provider, monthlyUsd, ...(since ? { since } : {}), ...(until ? { until } : {}), ...estimate }]
    }
    if (usd !== undefined && date) return [{ name, category, provider, usd, date, ...estimate }]
    return []
  })
  const estimates = Array.isArray(obj.estimates)
    ? obj.estimates.slice(0, MAX_ENTRIES).flatMap((item): CostEstimate[] => {
      if (!item || typeof item !== 'object') return []
      const i = item as Record<string, unknown>
      const name = text(i.name, 80)
      const monthlyUsd = amount(i.monthlyUsd)
      if (!name || monthlyUsd === undefined || isAi(i)) return []
      const basis = text(i.basis, 160)
      return [{ name, provider: providerOf(i.provider, name), monthlyUsd, ...(basis ? { basis } : {}) }]
    })
    : null
  return { items, estimates, checkedAt: dateOf(obj.checkedAt) }
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

function addTo(record: Record<string, number>, key: string, usd: number): Record<string, number> {
  return { ...record, [key]: (record[key] ?? 0) + usd }
}

function add(t: ExtraTotals, entry: CostEntry, usd: number): ExtraTotals {
  if (usd <= 0) return t
  return {
    usd: t.usd + usd,
    byCategory: { ...t.byCategory, [entry.category]: t.byCategory[entry.category] + usd },
    byProvider: addTo(t.byProvider, entry.provider, usd),
    items: addTo(t.items, entry.name, usd),
    estimated: t.estimated || entry.estimate === true
  }
}

function thisMonthIndex(now: number): number {
  const d = new Date(now)
  return monthIndex(d.getFullYear(), d.getMonth() + 1)
}

/** 今月・今年・総額に分ける（手元の時刻。未来の日付の1回きりのものは数えない） */
export function extraPeriods(entries: readonly CostEntry[], now: number): ExtraPeriods {
  const thisMonth = thisMonthIndex(now)
  const yearStart = monthIndex(new Date(now).getFullYear(), 1)
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

/** 推定の月額。estimates があればそれを、無ければ今月も続いている毎月の items を使う */
export function costForecast(file: CostFile, now: number): CostForecast {
  const thisMonth = thisMonthIndex(now)
  const list: CostEstimate[] = file.estimates
    ?? file.items.flatMap((e) => (e.monthlyUsd !== undefined && activeMonths(e, thisMonth, thisMonth) > 0 ? [{ name: e.name, provider: e.provider, monthlyUsd: e.monthlyUsd }] : []))
  let out: CostForecast = { ...EMPTY_FORECAST, checkedAt: file.estimates ? file.checkedAt : null, fromRecurring: file.estimates === null && list.length > 0 }
  for (const e of list) {
    if (e.monthlyUsd <= 0) continue
    out = {
      ...out,
      usd: out.usd + e.monthlyUsd,
      byProvider: addTo(out.byProvider, e.provider, e.monthlyUsd),
      items: addTo(out.items, e.name, e.monthlyUsd),
      basis: e.basis ? { ...out.basis, [e.name]: e.basis } : out.basis
    }
  }
  return out
}

export function sumExtra(list: readonly ExtraTotals[]): ExtraTotals {
  return list.reduce((acc, t) => {
    let { items, byProvider } = acc
    for (const [k, v] of Object.entries(t.items)) items = addTo(items, k, v)
    for (const [k, v] of Object.entries(t.byProvider)) byProvider = addTo(byProvider, k, v)
    const byCategory = { ...acc.byCategory }
    for (const c of COST_CATEGORIES) byCategory[c] += t.byCategory[c]
    return { usd: acc.usd + t.usd, byCategory, byProvider, items, estimated: acc.estimated || t.estimated }
  }, EMPTY_EXTRA)
}

export function sumForecast(list: readonly CostForecast[]): CostForecast {
  return list.reduce((acc, f) => {
    let { items, byProvider } = acc
    for (const [k, v] of Object.entries(f.items)) items = addTo(items, k, v)
    for (const [k, v] of Object.entries(f.byProvider)) byProvider = addTo(byProvider, k, v)
    const checkedAt = acc.checkedAt && f.checkedAt ? (acc.checkedAt < f.checkedAt ? acc.checkedAt : f.checkedAt) : (acc.checkedAt ?? f.checkedAt)
    return { usd: acc.usd + f.usd, byProvider, items, basis: { ...acc.basis, ...f.basis }, checkedAt, fromRecurring: acc.fromRecurring || f.fromRecurring }
  }, EMPTY_FORECAST)
}

export function formatUsd(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}
