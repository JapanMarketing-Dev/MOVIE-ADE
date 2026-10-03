import type {
  AccountAgent,
  AgentLaunchConfig,
  AgentPreferences,
  BuiltinAgent,
  CustomAgent,
  CustomAgentId,
  TuiAgent
} from './types'

/**
 * ターミナルから起動できるコーディングエージェントの一覧（main・renderer・単体テストで共有する純粋なデータと関数）。
 *
 * Orca由来: ~/bench/orca/src/shared/tui-agent-config.ts（detectCmd / detectCmdAliases / launchCmd / expectedProcess）,
 *           ~/bench/orca/src/shared/tui-agent-permissions.ts（YOLO_TUI_AGENT_ARGS）,
 *           ~/bench/orca/src/renderer/src/lib/agent-catalog.tsx（label / homepageUrl）,
 *           ~/bench/orca/src/shared/agent-process-recognition.ts,
 *           ~/bench/orca/src/shared/agent-node-package-entrypoints.ts,
 *           ~/bench/orca/src/shared/agent-node-entrypoint-identities.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca の50種近いエージェントのうち、主なものだけを持ってきた。足すときは BuiltinAgent（types.ts）と
 * 下の表に1行ずつ足す。プロンプトの注入方式など、本システムで使わない項目は持ち込んでいない。
 */

export interface AgentCatalogEntry {
  label: string
  /** PATH 上にあればインストール済みとみなすコマンド（Orca の detectCmd） */
  detectCmd: string
  /** 同じエージェントを指す別名（Orca の detectCmdAliases） */
  aliases?: readonly string[]
  /** 起動コマンド（Orca の launchCmd。省略時は detectCmd） */
  launchCmd?: string
  /** 権限確認を省く引数（Orca の YOLO_TUI_AGENT_ARGS）。無いものは空 */
  yoloArgs: string
  homepageUrl: string
}

/** メニューに並べる順（Orca のカタログ順を基に、よく使うものを先に） */
export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'copilot',
  'aider',
  'grok',
  'qwen-code',
  'amp'
]

export const AGENT_CATALOG: Record<BuiltinAgent, AgentCatalogEntry> = {
  claude: {
    label: 'Claude Code',
    detectCmd: 'claude',
    yoloArgs: '--dangerously-skip-permissions',
    homepageUrl: 'https://code.claude.com/docs'
  },
  codex: {
    label: 'Codex',
    detectCmd: 'codex',
    yoloArgs: '--dangerously-bypass-approvals-and-sandbox',
    homepageUrl: 'https://github.com/openai/codex'
  },
  gemini: {
    label: 'Gemini CLI',
    detectCmd: 'gemini',
    yoloArgs: '--yolo',
    homepageUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  opencode: {
    label: 'OpenCode',
    detectCmd: 'opencode',
    // Orca も OpenCode には権限確認を省く引数を持たない
    yoloArgs: '',
    homepageUrl: 'https://opencode.ai/docs/cli/'
  },
  cursor: {
    label: 'Cursor Agent',
    detectCmd: 'cursor-agent',
    yoloArgs: '--yolo',
    homepageUrl: 'https://cursor.com/cli'
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    detectCmd: 'copilot',
    yoloArgs: '--yolo',
    homepageUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'
  },
  aider: {
    label: 'Aider',
    detectCmd: 'aider',
    yoloArgs: '--yes-always',
    homepageUrl: 'https://aider.chat/docs/'
  },
  grok: {
    label: 'Grok',
    detectCmd: 'grok',
    yoloArgs: '--permission-mode bypassPermissions',
    homepageUrl: 'https://x.ai/cli'
  },
  'qwen-code': {
    label: 'Qwen Code',
    // パッケージ名は qwen-code だが、PATH に入るコマンドは qwen（Orca の注記）
    detectCmd: 'qwen',
    yoloArgs: '--approval-mode yolo',
    homepageUrl: 'https://github.com/QwenLM/qwen-code'
  },
  amp: {
    label: 'Amp',
    detectCmd: 'amp',
    yoloArgs: '--dangerously-allow-all',
    homepageUrl: 'https://ampcode.com/manual#install'
  }
}

/** アカウント切り替え・使用量の対象（設定フォルダを分けられるもの） */
export const ACCOUNT_AGENTS: readonly AccountAgent[] = ['claude', 'codex']

export const TUI_AGENT_LABEL: Record<BuiltinAgent, string> = Object.fromEntries(
  BUILTIN_AGENTS.map((agent) => [agent, AGENT_CATALOG[agent].label])
) as Record<BuiltinAgent, string>

export function defaultLaunchConfig(agent: BuiltinAgent): AgentLaunchConfig {
  const entry = AGENT_CATALOG[agent]
  return { command: entry.launchCmd ?? entry.detectCmd, args: entry.yoloArgs }
}

/** 既定の設定。起動コマンドと引数は Orca と同じ（権限確認を省くフラグ付き） */
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  launch: Object.fromEntries(BUILTIN_AGENTS.map((agent) => [agent, defaultLaunchConfig(agent)])) as Record<
    BuiltinAgent,
    AgentLaunchConfig
  >,
  customAgents: [],
  disabledAgents: [],
  startupAgents: ['claude', 'codex']
}

export function isBuiltinAgent(value: unknown): value is BuiltinAgent {
  return typeof value === 'string' && Object.hasOwn(AGENT_CATALOG, value)
}

export function isCustomAgentId(value: unknown): value is CustomAgentId {
  return typeof value === 'string' && /^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(value)
}

export function isAccountAgent(value: unknown): value is AccountAgent {
  return value === 'claude' || value === 'codex'
}

export function findCustomAgent(prefs: Pick<AgentPreferences, 'customAgents'> | null | undefined, id: TuiAgent): CustomAgent | undefined {
  // 古い形の設定（customAgents が無い）でも落ちないようにする
  return Array.isArray(prefs?.customAgents) ? prefs.customAgents.find((custom) => custom?.id === id) : undefined
}

/**
 * 表示名。カスタムは登録した名前、見つからなければ id の後半。
 * 設定の読み込み途中などで id が文字列でないときも落ちず、空文字を返す
 */
export function agentLabel(agent: TuiAgent | null | undefined, prefs?: Pick<AgentPreferences, 'customAgents'> | null): string {
  if (typeof agent !== 'string') return ''
  if (isBuiltinAgent(agent)) return TUI_AGENT_LABEL[agent]
  const name = findCustomAgent(prefs, agent)?.name
  return (typeof name === 'string' && name.trim()) || (agent.startsWith('custom:') ? agent.slice('custom:'.length) : agent)
}

/** 名前からカスタムエージェントの id を作る。重なれば -2, -3… を付ける */
export function newCustomAgentId(name: string, existing: readonly string[]): CustomAgentId {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  let id = `custom:${base}` as CustomAgentId
  for (let n = 2; existing.includes(id); n++) id = `custom:${base}-${n}` as CustomAgentId
  return id
}

/** コマンド文字列の先頭語（`npx -y foo` なら npx、`FOO=1 bar` なら bar） */
export function firstCommandWord(command: string): string {
  const words = command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  return words[0]?.replace(/^["']|["']$/g, '') ?? ''
}

/** PATH で探すコマンド。カスタムはコマンドの先頭語 */
export function detectCommandsFor(agent: TuiAgent, prefs: Pick<AgentPreferences, 'customAgents'>): string[] {
  if (isBuiltinAgent(agent)) {
    const entry = AGENT_CATALOG[agent]
    return [entry.detectCmd, ...(entry.aliases ?? [])]
  }
  const custom = findCustomAgent(prefs, agent)
  const word = custom ? firstCommandWord(custom.command) : ''
  return word ? [word] : []
}

// ───────────────────────── 前面プロセスからエージェントを同定する ─────────────────────────

const PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i
const SCRIPT_EXTENSION_RE = /\.(?:js|mjs|cjs|py|pyw)$/i
/** node / python などで動くCLIは、前面プロセス名が実行系になる。その次の引数（スクリプト）を見る */
const WRAPPER_PROCESSES = new Set(['node', 'bun', 'deno', 'python', 'python3'])
/**
 * スクリプト名だけでは決められない（index.js など）ものは、インストール先のパスで決める
 * （Orca の NODE_PACKAGE_SCRIPT_ENTRYPOINTS / EXACT_NODE_ENTRYPOINT_IDENTITIES から本システムの対象だけ）
 */
const PACKAGE_PATH_IDENTITIES: ReadonlyArray<{ pattern: RegExp; agent: BuiltinAgent }> = [
  { pattern: /node_modules\/@openai\/codex\//, agent: 'codex' },
  { pattern: /node_modules\/@google\/gemini-cli\//, agent: 'gemini' },
  { pattern: /(?:^|\/)cursor-agent\/versions\/[^/]+\/index\.js$/, agent: 'cursor' }
]

function normalizeProcessName(token: string | undefined, stripScript = false): string {
  if (!token) return ''
  const unquoted = token.trim().replace(/^["']|["']$/g, '')
  const base = (unquoted.split(/[\\/]/).pop() ?? unquoted).toLowerCase().replace(PROCESS_EXTENSION_RE, '')
  return stripScript ? base.replace(SCRIPT_EXTENSION_RE, '') : base
}

function processTable(prefs: Pick<AgentPreferences, 'customAgents'>): Map<string, TuiAgent> {
  const table = new Map<string, TuiAgent>()
  for (const agent of BUILTIN_AGENTS) {
    const entry = AGENT_CATALOG[agent]
    for (const name of [entry.detectCmd, ...(entry.aliases ?? []), firstCommandWord(entry.launchCmd ?? '')]) {
      const normalized = normalizeProcessName(name)
      if (normalized && !table.has(normalized)) table.set(normalized, agent)
    }
  }
  for (const custom of Array.isArray(prefs.customAgents) ? prefs.customAgents : []) {
    const normalized = normalizeProcessName(custom.processName?.trim() || firstCommandWord(custom.command))
    // 実行系（npx や node）だけでは同定できないので登録しない
    if (normalized && !WRAPPER_PROCESSES.has(normalized) && normalized !== 'npx' && !table.has(normalized)) {
      table.set(normalized, custom.id)
    }
  }
  return table
}

function agentForName(normalized: string, table: Map<string, TuiAgent>): TuiAgent | null {
  const exact = table.get(normalized)
  if (exact) return exact
  // Codex は codex-aarch64-apple-darwin のような名前で動くことがある（Orca の注記）。grok も同様
  if (normalized.startsWith('codex-')) return 'codex'
  if (normalized.startsWith('grok-')) return 'grok'
  return null
}

/**
 * プロセス名またはコマンド行から、どのエージェントかを返す。分からなければ null。
 * `node /opt/homebrew/bin/gemini` のように実行系が前に来る形も見る。
 */
export function agentForProcess(commandLine: string, prefs: Pick<AgentPreferences, 'customAgents'> = { customAgents: [] }): TuiAgent | null {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const table = processTable(prefs)
  const head = normalizeProcessName(tokens[0])
  const direct = agentForName(head, table)
  if (direct) return direct
  if (!WRAPPER_PROCESSES.has(head)) return null
  const rest = tokens.slice(1).filter((token) => !token.startsWith('-'))
  // python -m aider
  const moduleIndex = tokens.indexOf('-m')
  if (moduleIndex > 0 && tokens[moduleIndex + 1]) {
    const moduleAgent = agentForName(tokens[moduleIndex + 1]!.split('.')[0]!.toLowerCase(), table)
    if (moduleAgent) return moduleAgent
  }
  const script = rest[0]
  if (!script) return null
  const path = script.replace(/\\/g, '/')
  for (const identity of PACKAGE_PATH_IDENTITIES) if (identity.pattern.test(path)) return identity.agent
  return agentForName(normalizeProcessName(script, true), table)
}

// ───────────────────────── 設定の読み込み ─────────────────────────

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * 保存された設定を型どおりに直す。壊れた値は既定へ戻し、以前の形（claude / codex だけの launch）もそのまま引き継ぐ。
 * 登録の無いカスタムや知らない id は、startupAgents / disabledAgents から外す。
 * id のあるカスタムは書きかけでも残す（id が無く、名前かコマンドが空のものだけ捨てる）。
 */
export function sanitizeAgentPreferences(raw: unknown): AgentPreferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawLaunch = (r.launch && typeof r.launch === 'object' ? r.launch : {}) as Record<string, unknown>
  const launch = { ...DEFAULT_AGENT_PREFERENCES.launch }
  for (const agent of BUILTIN_AGENTS) {
    const c = rawLaunch[agent] as Partial<AgentLaunchConfig> | undefined
    // 空白だけのコマンドも未設定とみなして既定に戻す
    if (c && text(c.command)) launch[agent] = { command: text(c.command), args: text(c.args) }
  }

  const customAgents: CustomAgent[] = []
  for (const item of Array.isArray(r.customAgents) ? r.customAgents : []) {
    if (!item || typeof item !== 'object') continue
    const c = item as Partial<CustomAgent>
    const name = text(c.name)
    const command = text(c.command)
    // 設定画面は入力のたびに保存するので、書きかけ（名前やコマンドが空）でも id があれば残す。
    // 使えるかどうか（コマンドが空なら起動できない）はメニュー側で見る
    if (!isCustomAgentId(c.id) && (!name || !command)) continue
    const ids = customAgents.map((agent) => agent.id)
    const id = isCustomAgentId(c.id) && !ids.includes(c.id) ? c.id : newCustomAgentId(name, ids)
    const processName = text(c.processName)
    customAgents.push({ id, name, command, args: text(c.args), ...(processName ? { processName } : {}) })
  }

  const known = (value: unknown): value is TuiAgent =>
    isBuiltinAgent(value) || customAgents.some((custom) => custom.id === value)
  const list = (value: unknown, fallback: readonly TuiAgent[]): TuiAgent[] =>
    Array.isArray(value) ? [...new Set(value.filter(known))] : [...fallback]

  // 書きかけ（コマンドが空）のカスタムは起動できないので、起動時に開く一覧には入れない
  const launchable = (agent: TuiAgent): boolean => isBuiltinAgent(agent) || Boolean(findCustomAgent({ customAgents }, agent)?.command)
  return {
    launch,
    customAgents,
    disabledAgents: list(r.disabledAgents, DEFAULT_AGENT_PREFERENCES.disabledAgents),
    startupAgents: list(r.startupAgents, DEFAULT_AGENT_PREFERENCES.startupAgents).filter(launchable)
  }
}
