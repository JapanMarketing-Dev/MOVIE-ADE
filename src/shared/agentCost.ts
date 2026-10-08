/**
 * Agent のコストの概算（全体のダッシュボード。今月・今年・総額）。Claude Code が残す会話の記録（~/.claude/projects/<フォルダ>/*.jsonl）の
 * 各行の message.usage を足し、モデルの種類ごとの目安の単価で金額にする。目安なので画面では「概算」と出す。
 * 画面に依存しない純粋な処理だけを置く（読むのは src/main/orchestraOverview.ts）
 */

import type { ChecklistItem } from './humanChecklist'

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 概算の金額（USD） */
  usd: number
  /** 金額の内訳：トークンの種類ごと */
  usdBy: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** 金額の内訳：モデルごと（記録のモデル名。形の違う名前は other） */
  models: Record<string, number>
}

export const EMPTY_TOTALS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, usdBy: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, models: {} }
const MODEL_NAME = /^[A-Za-z0-9][\w.:@-]{0,63}$/

/** 100 万トークンあたりの目安（USD）。モデルの名前に含まれる語で選ぶ。知らないモデルは中くらいの単価 */
const PRICES: ReadonlyArray<{ match: RegExp; input: number; output: number }> = [
  { match: /opus/i, input: 15, output: 75 },
  { match: /fable/i, input: 15, output: 75 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /haiku/i, input: 1, output: 5 }
]
const DEFAULT_PRICE = { input: 3, output: 15 }

export function priceFor(model: string | undefined): { input: number; output: number } {
  return PRICES.find((p) => model && p.match.test(model)) ?? DEFAULT_PRICE
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** 記録の1行（JSON）の使った量と時刻。usage の無い行・壊れた行は null */
function lineUsage(line: string): { usage: TokenTotals; at: number | null } | null {
  if (!line.includes('"usage"')) return null
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return null }
  const record = parsed as { message?: { usage?: Record<string, unknown>; model?: string }; timestamp?: unknown }
  const usage = record?.message?.usage
  if (!usage || typeof usage !== 'object') return null
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheWrite = num(usage.cache_creation_input_tokens)
  const model = record.message?.model
  const price = priceFor(model)
  const usdBy = {
    input: (input * price.input) / 1_000_000,
    output: (output * price.output) / 1_000_000,
    cacheRead: (cacheRead * price.input * 0.1) / 1_000_000,
    cacheWrite: (cacheWrite * price.input * 1.25) / 1_000_000
  }
  const usd = usdBy.input + usdBy.output + usdBy.cacheRead + usdBy.cacheWrite
  const name = typeof model === 'string' && MODEL_NAME.test(model) ? model : 'other'
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  return { usage: { input, output, cacheRead, cacheWrite, usd, usdBy, models: usd > 0 ? { [name]: usd } : {} }, at: Number.isFinite(at) ? at : null }
}

function plus(a: TokenTotals, b: TokenTotals): TokenTotals {
  const models = { ...a.models }
  for (const [k, v] of Object.entries(b.models)) models[k] = (models[k] ?? 0) + v
  return {
    input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, usd: a.usd + b.usd,
    usdBy: { input: a.usdBy.input + b.usdBy.input, output: a.usdBy.output + b.usdBy.output, cacheRead: a.usdBy.cacheRead + b.usdBy.cacheRead, cacheWrite: a.usdBy.cacheWrite + b.usdBy.cacheWrite },
    models
  }
}

export type CostPeriod = 'month' | 'year' | 'total'
export const COST_PERIODS: readonly CostPeriod[] = ['month', 'year', 'total']

/** 記録の1行（JSON）を足す。usage の無い行・壊れた行は飛ばす */
export function addTranscriptLine(totals: TokenTotals, line: string): TokenTotals {
  const hit = lineUsage(line)
  return hit ? plus(totals, hit.usage) : totals
}

/** 期間ごとのコスト（今月・今年・総額）。総額は残っている記録の全部（Claude Code は既定で 30 日より古い記録を消す） */
export interface CostPeriods {
  month: TokenTotals
  year: TokenTotals
  total: TokenTotals
}

export const EMPTY_PERIODS: CostPeriods = { month: EMPTY_TOTALS, year: EMPTY_TOTALS, total: EMPTY_TOTALS }

/** 今月の初め・今年の初め（手元の時刻） */
export function periodStarts(now: number): { month: number; year: number } {
  const d = new Date(now)
  return { month: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), year: new Date(d.getFullYear(), 0, 1).getTime() }
}

/** 記録の1行を期間ごとに足す。行に時刻が無ければ fallbackAt（ファイルの更新時刻）で数える */
export function addTranscriptLineByPeriod(periods: CostPeriods, line: string, fallbackAt: number, starts: { month: number; year: number }): CostPeriods {
  const hit = lineUsage(line)
  if (!hit) return periods
  const at = hit.at ?? fallbackAt
  return {
    month: at >= starts.month ? plus(periods.month, hit.usage) : periods.month,
    year: at >= starts.year ? plus(periods.year, hit.usage) : periods.year,
    total: plus(periods.total, hit.usage)
  }
}

/** 足し合わせ（全体のダッシュボードの合計・内訳） */
export function sumTotals(list: readonly TokenTotals[]): TokenTotals {
  return list.reduce(plus, EMPTY_TOTALS)
}

export function sumPeriods(list: readonly CostPeriods[]): CostPeriods {
  return list.reduce((acc, p) => ({ month: plus(acc.month, p.month), year: plus(acc.year, p.year), total: plus(acc.total, p.total) }), EMPTY_PERIODS)
}

/** Claude Code が会話の記録を置くフォルダの名前（cwd の英数字以外を - に。src/shared/terminalRestore.ts と同じ） */
export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function formatUsd(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

/** 全体のダッシュボードに出すもの（src/main/orchestraOverview.ts） */
export interface ProjectOverview {
  id: string
  name: string
  included: boolean
  /** まだ直していない指摘（送ったが完了していないものを含む） */
  open: number
  /** 人の確認を待っている指摘（before / after） */
  pending: number
  reviews: number
  /** 最後のレビューの id（YYYYMMDD-HHMMSS） */
  lastReview: string | null
  cost: CostPeriods
  /** .ferret/costs.json のインフラ・サービスなど（@shared/extraCost） */
  extra: import('./extraCost').ExtraPeriods
}

export interface OrchestraOverview {
  projects: ProjectOverview[]
  /** 全体の Agent 自身のコスト（subagent を含む） */
  orchestraCost: CostPeriods
  /** 全体で共有するインフラ・サービスなど（全体のフォルダの .ferret/costs.json） */
  orchestraExtra: import('./extraCost').ExtraPeriods
  checklist: ChecklistItem[]
  /** human.md の場所（無ければ null） */
  checklistPath: string | null
}

