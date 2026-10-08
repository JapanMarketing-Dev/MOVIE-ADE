/**
 * Agent のコストの概算（全体のダッシュボード）。Claude Code が残す会話の記録（~/.claude/projects/<フォルダ>/*.jsonl）の
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
}

export const EMPTY_TOTALS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }

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

/** 記録の1行（JSON）を足す。usage の無い行・壊れた行は飛ばす */
export function addTranscriptLine(totals: TokenTotals, line: string): TokenTotals {
  if (!line.includes('"usage"')) return totals
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return totals }
  const message = (parsed as { message?: { usage?: Record<string, unknown>; model?: string } })?.message
  const usage = message?.usage
  if (!usage || typeof usage !== 'object') return totals
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheWrite = num(usage.cache_creation_input_tokens)
  const price = priceFor(message?.model)
  const usd = (input * price.input + output * price.output + cacheRead * price.input * 0.1 + cacheWrite * price.input * 1.25) / 1_000_000
  return {
    input: totals.input + input,
    output: totals.output + output,
    cacheRead: totals.cacheRead + cacheRead,
    cacheWrite: totals.cacheWrite + cacheWrite,
    usd: totals.usd + usd
  }
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
  cost: TokenTotals
}

export interface OrchestraOverview {
  projects: ProjectOverview[]
  /** 全体の Agent 自身のコスト（subagent を含む） */
  orchestraCost: TokenTotals
  checklist: ChecklistItem[]
  /** human.md の場所（無ければ null） */
  checklistPath: string | null
  /** コストを数えた期間（日） */
  costDays: number
}

