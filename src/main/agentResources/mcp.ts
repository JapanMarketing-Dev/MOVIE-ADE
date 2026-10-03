import type { AgentResourceItem, AgentResourceSource, McpTransport } from '@shared/agentResources'
import { asRecord } from './read'

/**
 * MCP サーバーの設定を、画面に出してよい形にする。
 *
 * 出すのは、名前・種類（stdio / http / sse）・コマンドのファイル名か URL の host だけ。
 * env・headers・args・URL のパス／クエリ／ユーザー情報は、ここで捨てて先へ渡さない。
 * 設定の値（キーやトークンが入りうる）を、ログ・例外・Sentry にも出さない。
 */

/** コマンドのファイル名だけ（/Users/<名前>/... のようなパスを出さない） */
export function commandName(command: unknown): string | null {
  if (typeof command !== 'string') return null
  const trimmed = command.trim()
  if (!trimmed) return null
  // 引数ごと1つの文字列で書かれていても、最初の語だけを使う
  const first = trimmed.split(/\s+/)[0]!
  const name = first.split(/[\\/]/).pop() ?? ''
  return name || null
}

/** URL の host だけ（ユーザー情報・パス・クエリ・断片は捨てる） */
export function urlHost(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  try {
    return new URL(url.trim()).host || null
  } catch {
    return null
  }
}

function transportOf(raw: Record<string, unknown>): McpTransport {
  const declared = typeof raw.type === 'string' ? raw.type : typeof raw.transport === 'string' ? raw.transport : null
  const normalized = declared?.toLowerCase().replace(/[^a-z]/g, '')
  if (normalized === 'stdio') return 'stdio'
  if (normalized === 'sse') return 'sse'
  if (normalized === 'http' || normalized === 'streamablehttp') return 'http'
  if (typeof raw.command === 'string') return 'stdio'
  if (typeof raw.url === 'string' || typeof raw.httpUrl === 'string' || typeof raw.serverUrl === 'string') return 'http'
  return 'unknown'
}

/** 1件の MCP サーバーの設定 → 出してよい項目 */
export function sanitizeMcpServer(name: string, value: unknown, source: AgentResourceSource): AgentResourceItem | null {
  const raw = asRecord(value)
  if (!raw || !name.trim()) return null
  const transport = transportOf(raw)
  const target = transport === 'stdio' ? commandName(raw.command) : urlHost(raw.url ?? raw.httpUrl ?? raw.serverUrl)
  return { kind: 'mcp', name: name.trim(), description: null, source, transport, target }
}

/** { 名前: 設定 } の形（Claude の mcpServers・Gemini の mcpServers） */
export function sanitizeMcpServers(servers: unknown, source: AgentResourceSource): AgentResourceItem[] {
  const record = asRecord(servers)
  if (!record) return []
  return Object.entries(record).flatMap(([name, value]) => {
    const item = sanitizeMcpServer(name, value, source)
    return item ? [item] : []
  })
}

/**
 * Codex の config.toml から、mcp_servers の下の各サーバーの表（名前ごと）を読む。
 * TOML を全部は解釈せず、表の見出しと、その表の command / url / transport の1行の文字列だけを見る。
 * 各サーバーの下の env などの表（秘密が入る）は読まない。
 */
export function parseCodexMcpServers(toml: string): Array<{ name: string; config: Record<string, unknown> }> {
  const servers: Array<{ name: string; config: Record<string, unknown> }> = []
  let current: Record<string, unknown> | null = null
  for (const rawLine of toml.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      current = null
      const header = /^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(#.*)?$/.exec(line)
      if (header) {
        current = {}
        servers.push({ name: header[1] ?? header[2] ?? header[3]!, config: current })
      }
      continue
    }
    if (!current) continue
    const pair = /^(command|url|transport|type)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line)
    if (pair) current[pair[1]!] = pair[2] !== undefined ? pair[2].replace(/\\(.)/g, '$1') : pair[3]
  }
  return servers
}
