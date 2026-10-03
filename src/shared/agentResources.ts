import type { TuiAgent } from './types'

/**
 * 設定の Agents の節に出す、Agent CLI ごとの「スキル・スラッシュコマンド・MCP サーバー」の一覧（main → renderer）。
 *
 * 読むだけで、どのファイルも書き換えない。
 * MCP サーバーは、名前・種類・コマンド名（または URL の host）だけを持つ。
 * env・headers・args・URL のパスとクエリは、この型に入れない（画面・ログ・Sentry に出さないため）。
 */

export type AgentResourceKind = 'skill' | 'command' | 'mcp'

export type AgentResourceSource =
  | { type: 'user' }
  | { type: 'project' }
  | { type: 'plugin'; plugin: string }

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown'

export interface AgentResourceItem {
  kind: AgentResourceKind
  /** スキル名・コマンド名（/ は付けない）・MCP サーバー名 */
  name: string
  /** SKILL.md の description、コマンドの description か1行目。MCP は持たない */
  description: string | null
  source: AgentResourceSource
  /** MCP のときだけ */
  transport?: McpTransport
  /** MCP のときだけ。stdio はコマンドのファイル名、http / sse は URL の host */
  target?: string | null
}

/** 読めなかったもの。ファイル名（パスではなく最後の名前）だけを持つ */
export interface AgentResourceWarning {
  code: 'broken' | 'tooLarge' | 'truncated'
  file: string
}

export interface AgentResourceList {
  agent: TuiAgent
  /** 読み方が分かっている CLI か。false なら「未対応」とだけ出す */
  supported: boolean
  items: AgentResourceItem[]
  warnings: AgentResourceWarning[]
}
