import { AGENT_CATALOG, isBuiltinAgent } from '@shared/agentCatalog'
import type { AgentOption, TuiAgent } from '@shared/types'

/**
 * エージェントが多い（40種以上）ときの並べ方と絞り込み（オンボーディングと設定の Agents 節で共有。純粋関数）。
 *
 * Orca由来の考え方: ~/bench/orca/src/renderer/src/components/onboarding/AgentStep.tsx
 * （検出済みを先に並べ、無いものには入れ方を出す）（MIT, Copyright 2026 Lovecast Inc.）
 *
 * - 並び: 見つかったもの → 主要なもの（popular）→ 残り。それぞれの中はカタログの順
 * - 普段は「見つかったもの・主要なもの・選んでいるもの」だけを見せ、残りは「すべて表示（N）」にたたむ
 * - 検索欄に入れたら、たたんだものも含めて名前・id・コマンドで絞り込む
 */

export interface AgentListing<T extends AgentOption> {
  visible: T[]
  /** たたんでいる数（「すべて表示（N）」の N）。検索中・すべて表示中は 0 */
  hiddenCount: number
}

/** 空白で区切った語が、名前・id・検出コマンド・起動コマンドのどれかにすべて含まれれば一致 */
export function matchesAgentQuery(option: Pick<AgentOption, 'id' | 'label' | 'command'>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const entry = isBuiltinAgent(option.id) ? AGENT_CATALOG[option.id] : undefined
  const haystack = [option.label, option.id, option.command, entry?.detectCmd ?? '', ...(entry?.aliases ?? [])].join(' ').toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

function rank(option: AgentOption): number {
  if (option.installed) return 0
  if (isBuiltinAgent(option.id) && AGENT_CATALOG[option.id].popular) return 1
  return 2
}

export function listAgents<T extends AgentOption>(
  options: readonly T[],
  args: { query?: string; showAll?: boolean; selected?: readonly TuiAgent[] } = {}
): AgentListing<T> {
  // 同じ順位の中は渡された順（カタログの順）を保つ
  const ordered = options.map((option, index) => ({ option, index })).sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index).map((x) => x.option)
  const query = args.query?.trim() ?? ''
  if (query) return { visible: ordered.filter((option) => matchesAgentQuery(option, query)), hiddenCount: 0 }
  if (args.showAll) return { visible: ordered, hiddenCount: 0 }
  const selected = new Set(args.selected ?? [])
  const visible = ordered.filter((option) => rank(option) < 2 || option.custom || selected.has(option.id))
  return { visible, hiddenCount: ordered.length - visible.length }
}
