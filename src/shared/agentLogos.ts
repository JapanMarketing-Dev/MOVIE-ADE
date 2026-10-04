import { AGENT_CATALOG, BUILTIN_AGENTS, ORCA_SUPPORTED_AGENTS } from './agentCatalog'
import type { BuiltinAgent } from './types'

/**
 * README・サイトの「対応エージェント」のロゴ一覧に使う、機械で読める一覧（アプリの画面では使わない）。
 * 同じ内容を docs/images/agents/agents.json にも置く（サイトは TS を読めないため。ずれは単体テストで確かめる）。
 *
 * ロゴの画像は docs/images/agents/ に置く。
 * Orca由来: ~/bench/orca/src/shared/agent-icons/*.png, ~/bench/orca/docs/assets/droid-logo.svg,
 *           ~/bench/orca/src/renderer/src/lib/agent-icon-glyphs.tsx（Pi / OMP / Kilo / Aider の SVG）,
 *           ~/bench/orca/src/renderer/src/lib/agent-favicon-assets.ts（MIT, Copyright 2026 Lovecast Inc.）
 * 単色の SVG（codex・pi・aider）は <img> だと黒になるので、明暗どちらでも見えるよう色を持たせている。
 */

interface AgentLogo {
  id: BuiltinAgent
  name: string
  homepageUrl: string
  /** リポジトリの根からの相対パス。ロゴが無いものは null（頭文字で代える） */
  icon: string | null
}

const AGENT_LOGO_DIR = 'docs/images/agents'

const SVG_LOGOS: ReadonlySet<BuiltinAgent> = new Set<BuiltinAgent>(['claude', 'codex', 'aider', 'pi', 'omp', 'kilo', 'droid'])
/** ロゴの画像が無いもの（Orca に無く、追加したもの） */
const NO_LOGO: ReadonlySet<BuiltinAgent> = new Set<BuiltinAgent>(['blackbox', 'forge', 'junie', 'letta', 'openhands', 'roo'])

function agentLogoPath(id: BuiltinAgent): string | null {
  if (NO_LOGO.has(id)) return null
  return `${AGENT_LOGO_DIR}/${id}.${SVG_LOGOS.has(id) ? 'svg' : 'png'}`
}

/** Orca の README の順に並べ、残り（Orca の README に無いもの）はカタログの順で後ろに付ける */
export function agentLogoList(): AgentLogo[] {
  const rest = BUILTIN_AGENTS.filter((id) => !ORCA_SUPPORTED_AGENTS.includes(id))
  return [...ORCA_SUPPORTED_AGENTS, ...rest].map((id) => ({
    id,
    name: AGENT_CATALOG[id].label,
    homepageUrl: AGENT_CATALOG[id].homepageUrl,
    icon: agentLogoPath(id)
  }))
}
