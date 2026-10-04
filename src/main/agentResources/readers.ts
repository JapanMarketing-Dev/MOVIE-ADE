import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { AgentResourceSource } from '@shared/agentResources'
import { parseCodexMcpServers, sanitizeMcpServer, sanitizeMcpServers } from './mcp'
import { Collector, asRecord, describeMarkdown, listDir, readConfig, readHead, readJsonConfig } from './read'

/**
 * CLI ごとの、スキル・スラッシュコマンド・MCP サーバーの読み方。
 * 置き場所は各 CLI の決まり（CLAUDE_CONFIG_DIR・CODEX_HOME など）に従う。読むだけで書き換えない。
 */

const USER: AgentResourceSource = { type: 'user' }
const PROJECT: AgentResourceSource = { type: 'project' }

/** コマンドの名前空間（サブフォルダ）をたどる深さ */
const MAX_COMMAND_DEPTH = 3

/** <dir>/<名前>/SKILL.md */
async function readSkills(dir: string, source: AgentResourceSource, collector: Collector): Promise<void> {
  for (const entry of await listDir(dir)) {
    if (!entry.isDir || entry.name.startsWith('.')) continue
    const head = await readHead(join(dir, entry.name, 'SKILL.md'))
    if (head === null) continue
    const { name, description } = describeMarkdown(head)
    if (!collector.add({ kind: 'skill', name: name ?? entry.name, description, source })) return
  }
}

/** <dir>/**\/*.md（サブフォルダは「sub:name」）。ext を変えれば Gemini の .toml にも使う */
async function readCommands(
  dir: string,
  source: AgentResourceSource,
  collector: Collector,
  options: { ext: '.md' | '.toml'; prefix?: string; depth?: number } = { ext: '.md' }
): Promise<void> {
  const depth = options.depth ?? 0
  for (const entry of await listDir(dir)) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDir) {
      if (depth < MAX_COMMAND_DEPTH) {
        await readCommands(join(dir, entry.name), source, collector, { ...options, prefix: `${options.prefix ?? ''}${entry.name}:`, depth: depth + 1 })
      }
      continue
    }
    if (!entry.isFile || extname(entry.name).toLowerCase() !== options.ext) continue
    const head = await readHead(join(dir, entry.name))
    if (head === null) continue
    const description = options.ext === '.md' ? describeMarkdown(head).description : tomlDescription(head)
    if (!collector.add({ kind: 'command', name: `${options.prefix ?? ''}${basename(entry.name, extname(entry.name))}`, description, source })) return
  }
}

/** Gemini のコマンド（.toml）の description = "..." */
function tomlDescription(text: string): string | null {
  const match = /^\s*description\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m.exec(text)
  const value = match ? (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1').trim() : ''
  return value || null
}

function addAll(collector: Collector, items: ReturnType<typeof sanitizeMcpServers>): void {
  for (const item of items) if (!collector.add(item)) return
}

// ───────────────────────── Claude Code ─────────────────────────

/** Claude Code の全体設定（.claude.json）の場所。CLAUDE_CONFIG_DIR があればその中、無ければ ~/.claude.json */
function claudeGlobalConfigPath(configDir: string, inherited: boolean): string {
  if (inherited) return join(configDir, '.claude.json')
  const colocated = join(configDir, '.claude.json')
  return existsSync(colocated) ? colocated : join(homedir(), '.claude.json')
}

/** 有効なプラグインのインストール先（settings.json の enabledPlugins × plugins/installed_plugins.json） */
async function enabledClaudePlugins(configDir: string, projectDir: string | null, collector: Collector): Promise<Array<{ name: string; root: string }>> {
  const enabled = new Map<string, boolean>()
  const settingsFiles = [join(configDir, 'settings.json')]
  if (projectDir) settingsFiles.push(join(projectDir, '.claude', 'settings.json'), join(projectDir, '.claude', 'settings.local.json'))
  // 後の（プロジェクトの）設定が前の（ユーザーの）設定を上書きする
  for (const file of settingsFiles) {
    const plugins = asRecord((await readJsonConfig(file, collector))?.enabledPlugins)
    for (const [key, value] of Object.entries(plugins ?? {})) if (typeof value === 'boolean') enabled.set(key, value)
  }
  const installed = asRecord((await readJsonConfig(join(configDir, 'plugins', 'installed_plugins.json'), collector))?.plugins)
  const roots: Array<{ name: string; root: string }> = []
  for (const [key, on] of enabled) {
    if (!on) continue
    const entry = installed?.[key]
    const first = asRecord(Array.isArray(entry) ? entry[0] : entry)
    const root = typeof first?.installPath === 'string' ? first.installPath : null
    if (root) roots.push({ name: key.split('@')[0] || key, root })
  }
  return roots
}

export async function readClaudeResources(options: { configDir: string; inheritedConfigDir: boolean; projectDir: string | null }): Promise<Collector> {
  const { configDir, projectDir } = options
  const collector = new Collector()
  const plugins = await enabledClaudePlugins(configDir, projectDir, collector)

  await readSkills(join(configDir, 'skills'), USER, collector)
  if (projectDir) await readSkills(join(projectDir, '.claude', 'skills'), PROJECT, collector)
  for (const plugin of plugins) await readSkills(join(plugin.root, 'skills'), { type: 'plugin', plugin: plugin.name }, collector)

  await readCommands(join(configDir, 'commands'), USER, collector)
  if (projectDir) await readCommands(join(projectDir, '.claude', 'commands'), PROJECT, collector)
  for (const plugin of plugins) await readCommands(join(plugin.root, 'commands'), { type: 'plugin', plugin: plugin.name }, collector)

  const global = await readJsonConfig(claudeGlobalConfigPath(configDir, options.inheritedConfigDir), collector)
  addAll(collector, sanitizeMcpServers(global?.mcpServers, USER))
  if (projectDir) {
    addAll(collector, sanitizeMcpServers(asRecord(asRecord(global?.projects)?.[projectDir])?.mcpServers, PROJECT))
    addAll(collector, sanitizeMcpServers((await readJsonConfig(join(projectDir, '.mcp.json'), collector))?.mcpServers, PROJECT))
  }
  for (const plugin of plugins) {
    const config = await readJsonConfig(join(plugin.root, '.mcp.json'), collector)
    // プラグインの .mcp.json は { mcpServers: {...} } と、名前を直に並べた形の両方がある
    addAll(collector, sanitizeMcpServers(config?.mcpServers ?? config, { type: 'plugin', plugin: plugin.name }))
  }
  return collector
}

// ───────────────────────── Codex ─────────────────────────

export async function readCodexResources(options: { codexHome: string }): Promise<Collector> {
  const { codexHome } = options
  const collector = new Collector()
  await readSkills(join(codexHome, 'skills'), USER, collector)
  await readCommands(join(codexHome, 'prompts'), USER, collector)
  const configPath = join(codexHome, 'config.toml')
  const config = await readConfig(configPath)
  if (config.kind === 'tooLarge') collector.warn('tooLarge', configPath)
  if (config.kind === 'ok') {
    for (const { name, config: server } of parseCodexMcpServers(config.text)) {
      const item = sanitizeMcpServer(name, server, USER)
      if (item && !collector.add(item)) break
    }
  }
  return collector
}

// ───────────────────────── Gemini CLI ─────────────────────────

/** ~/.gemini と <プロジェクト>/.gemini の settings.json の mcpServers と、commands/*.toml */
export async function readGeminiResources(options: { geminiHome: string; projectDir: string | null }): Promise<Collector> {
  const { geminiHome, projectDir } = options
  const collector = new Collector()
  await readCommands(join(geminiHome, 'commands'), USER, collector, { ext: '.toml' })
  if (projectDir) await readCommands(join(projectDir, '.gemini', 'commands'), PROJECT, collector, { ext: '.toml' })
  addAll(collector, sanitizeMcpServers((await readJsonConfig(join(geminiHome, 'settings.json'), collector))?.mcpServers, USER))
  if (projectDir) addAll(collector, sanitizeMcpServers((await readJsonConfig(join(projectDir, '.gemini', 'settings.json'), collector))?.mcpServers, PROJECT))
  return collector
}
