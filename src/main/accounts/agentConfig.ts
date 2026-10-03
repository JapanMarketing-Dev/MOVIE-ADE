import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AccountAgent } from '@shared/types'
import { errorKind, reportHandled } from '@shared/report'

/**
 * 管理アカウントの設定フォルダへ、システムの既定アカウントの設定を持ち込む。
 *
 * Orca由来: ~/bench/orca/src/main/codex-accounts/codex-config-mirror.ts,
 *           ~/bench/orca/src/main/codex/codex-daemon-socket-path-guard.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca は ~/.codex/config.toml と管理フォルダの config.toml を双方向に同期するが、
 * 本システムでは作成時に1度写すだけにした（以降の変更は管理フォルダ側に残る）。
 * ~/.codex・~/.claude は読むだけで書き換えない。
 */

/** 作成時に写す設定ファイル（利用者が中で変えても元へは戻さない） */
const SEED_FILES: Record<AccountAgent, string[]> = {
  codex: ['config.toml'],
  claude: ['settings.json']
}

/**
 * 共有する置き場所。シンボリックリンクで既定アカウントのものを見せる
 * （指示ファイル・スキル・自作コマンド・プラグイン・フックがアカウントを替えても使えるように）。
 * 認証情報（.credentials.json・auth.json）と、会話の履歴・アカウントごとの状態は含めない。
 * プラグインの追加・削除はリンク先（既定アカウント側）に入る。どのアカウントでも同じプラグインを使うため。
 */
const SHARED_ENTRIES: Record<AccountAgent, string[]> = {
  codex: ['AGENTS.md', 'prompts', 'skills'],
  claude: ['CLAUDE.md', 'commands', 'agents', 'skills', 'plugins', 'hooks']
}

/**
 * Claude の全体設定（.claude.json）から写してよい項目。
 * MCP サーバーと、初回の案内・お知らせを抑える既読の印だけ。
 * oauthAccount・userID・API キーの応答（customApiKeyResponses）・会話の履歴（projects の中身）は写さない。
 */
export const CLAUDE_GLOBAL_CONFIG_KEYS = [
  'mcpServers',
  // 古い Claude Code が権限確認を省くモードの同意を全体設定に置いていた項目名
  'bypassPermissionsModeAccepted',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'lastReleaseNotesSeen',
  'hasIdeOnboardingBeenShown',
  'hasAcknowledgedCostThreshold',
  'shiftEnterKeyBindingInstalled',
  'theme',
  'autoUpdates',
  'installMethod',
  'preferredNotifChannel',
  'verbose',
  'autoConnectIde',
  'editorMode'
] as const

/**
 * 既定アカウントの .claude.json から、写してよい項目だけを取り出す。
 * フォルダの信頼（projects[パス].hasTrustDialogAccepted）は、信頼済みのものだけ印として写す（履歴は写さない）。
 */
export function pickClaudeGlobalConfig(source: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of CLAUDE_GLOBAL_CONFIG_KEYS) if (key in source) picked[key] = source[key]
  const projects = source.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    const trusted: Record<string, { hasTrustDialogAccepted: true }> = {}
    for (const [path, value] of Object.entries(projects as Record<string, unknown>)) {
      if (value && typeof value === 'object' && (value as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true) {
        trusted[path] = { hasTrustDialogAccepted: true }
      }
    }
    if (Object.keys(trusted).length > 0) picked.projects = trusted
  }
  return picked
}

/** 既定アカウントの .claude.json の場所。CLAUDE_CONFIG_DIR が無ければ ~/.claude.json（Claude Code と同じ） */
export function systemClaudeGlobalConfigPath(systemDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const inherited = env.CLAUDE_CONFIG_DIR?.trim()
  if (inherited) return join(inherited, '.claude.json')
  const colocated = join(systemDir, '.claude.json')
  return existsSync(colocated) ? colocated : join(dirname(systemDir), '.claude.json')
}

function seedClaudeGlobalConfig(managedDir: string, sourcePath: string): void {
  const target = join(managedDir, '.claude.json')
  try {
    if (!existsSync(sourcePath) || lstatExists(target)) return
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown
    if (!source || typeof source !== 'object' || Array.isArray(source)) return
    const picked = pickClaudeGlobalConfig(source as Record<string, unknown>)
    if (Object.keys(picked).length > 0) writeFileSync(target, `${JSON.stringify(picked, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (err) {
    // 中身（MCP の鍵など）を含みうるので、エラーの種類だけを出す
    console.warn('[accounts] Claude の全体設定を写せませんでした', err instanceof Error ? err.name : typeof err)
    reportHandled(errorKind(err), { area: 'accounts', op: 'copy claude global config' })
  }
}

/**
 * Claude の settings.json から、追加したアカウントへ引き継ぐ項目。
 * skipDangerousModePermissionPrompt は「権限確認を省くモードを使いますか」に同意済みの印
 * （起動引数の --dangerously-skip-permissions のたびに確認が出ないようにする）。
 */
export const CLAUDE_SETTINGS_CARRY_KEYS = ['skipDangerousModePermissionPrompt'] as const

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    // 無い・壊れている設定は「無い」として扱う（想定内。呼び出し側が既定で続ける）
    return null
  }
}

/**
 * 既定アカウントの settings.json の引き継ぐ項目を、管理フォルダの settings.json に無ければ足す。
 * 管理フォルダ側にすでに値があれば変えない（利用者がそのアカウントで変えた値を尊重する）。足したら true。
 */
export function carryClaudeSettings(managedDir: string, systemDir: string): boolean {
  const target = join(managedDir, 'settings.json')
  // 共有のつもりでリンクにされていたら、リンク先（既定アカウント側）へは書かない
  if (lstatExists(target) && lstatSync(target).isSymbolicLink()) return false
  const source = readJsonObject(join(systemDir, 'settings.json'))
  if (!source) return false
  const current = existsSync(target) ? readJsonObject(target) : {}
  if (!current) return false
  const additions = CLAUDE_SETTINGS_CARRY_KEYS.filter((key) => key in source && !(key in current))
  if (additions.length === 0) return false
  const next = { ...current }
  for (const key of additions) next[key] = source[key]
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return true
}

/** 一度だけ行う手直しの記録（管理フォルダの中に置く） */
const MIGRATION_MARKER = '.ade-migrations'
const CLAUDE_CARRY_MIGRATION = 'claude-settings-carry-v1'

/**
 * 以前に追加したアカウントへ、あとから引き継ぐことにした項目を1回だけ足す（Agent を起動する前に呼ぶ）。
 * 失敗しても起動は止めない。
 */
export function migrateManagedClaudeDir(managedDir: string, systemDir: string): void {
  const markerPath = join(managedDir, MIGRATION_MARKER)
  try {
    const done = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').split('\n').map((l) => l.trim()) : []
    if (done.includes(CLAUDE_CARRY_MIGRATION)) return
    carryClaudeSettings(managedDir, systemDir)
    writeFileSync(markerPath, `${[...done.filter(Boolean), CLAUDE_CARRY_MIGRATION].join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    console.warn('[accounts] 追加アカウントの設定を手直しできませんでした', err instanceof Error ? err.name : typeof err)
    reportHandled(errorKind(err), { area: 'accounts', op: 'migrate account settings' })
  }
}

/** 新しい設定フォルダを用意する。失敗しても追加そのものは止めない */
export function seedManagedAccountDir(agent: AccountAgent, managedDir: string, systemDir: string): void {
  if (agent === 'claude') seedClaudeGlobalConfig(managedDir, systemClaudeGlobalConfigPath(systemDir))
  for (const name of SEED_FILES[agent]) {
    const source = join(systemDir, name)
    const target = join(managedDir, name)
    try {
      if (existsSync(source) && !existsSync(target)) copyFileSync(source, target)
    } catch (err) {
      console.warn(`[accounts] ${name} を写せませんでした`, err)
      reportHandled(err, { area: 'accounts', op: 'copy account file' })
    }
  }
  for (const name of SHARED_ENTRIES[agent]) {
    const source = join(systemDir, name)
    const target = join(managedDir, name)
    try {
      if (!existsSync(source) || lstatExists(target)) continue
      symlinkSync(realpathSync(source), target)
    } catch (err) {
      console.warn(`[accounts] ${name} を共有できませんでした`, err)
      reportHandled(err, { area: 'accounts', op: 'link account file' })
    }
  }
  if (agent === 'claude') {
    // settings.json を写せなかった（既にあった）ときも、同意の印だけは引き継ぐ。以後の手直しは不要と記録する
    try {
      carryClaudeSettings(managedDir, systemDir)
    } catch (err) {
      console.warn('[accounts] Claude の設定を引き継げませんでした', err instanceof Error ? err.name : typeof err)
      reportHandled(errorKind(err), { area: 'accounts', op: 'carry claude settings' })
    }
    migrateManagedClaudeDir(managedDir, systemDir)
  }
  if (agent === 'codex') ensureCodexDaemonSocketGuard(managedDir)
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    // 無いことを調べている（想定内）
    return false
  }
}

// ───────────────────────── Codex のデーモン用ソケットの長さ対策 ─────────────────────────

/**
 * Codex 0.157 以降は <CODEX_HOME>/app-server-control/app-server-control.sock に接続する。
 * userData 配下の管理フォルダはパスが長く、Unix ソケットの上限（macOS 104 / Linux 108 バイト）を超えると
 * 「path must be shorter than SUN_LEN」で起動できない。超えるときだけ自動起動を切る（Orca と同じ対策）。
 */
const DAEMON_SOCKET_SEGMENTS = ['app-server-control', 'app-server-control.sock']
export const CODEX_DAEMON_OVERRIDE_MARKER = '# ade: CODEX_HOME too long for the daemon socket'

export function codexDaemonSocketPathExceedsLimit(homePath: string, platform: NodeJS.Platform = process.platform): boolean {
  let canonical = homePath
  try {
    canonical = realpathSync.native(homePath)
  } catch {
    // 解決できなければ書かれたまま測る
  }
  const socketPath = [canonical.replace(/[\\/]+$/, ''), ...DAEMON_SOCKET_SEGMENTS].join(platform === 'win32' ? '\\' : '/')
  return Buffer.byteLength(socketPath, 'utf8') > (platform === 'darwin' ? 103 : 107)
}

/**
 * config.toml の [features] に daemon_auto_start = false を足す（既にあれば触らない）。
 * Orca の upsertTableSettingsInContent ほど一般的ではなく、`[features]` の表見出しがある形だけを扱う。
 */
export function applyCodexDaemonSocketGuard(config: string, homePath: string, platform: NodeJS.Platform = process.platform): string {
  if (!codexDaemonSocketPathExceedsLimit(homePath, platform)) return config
  if (/^\s*daemon_auto_start\s*=/m.test(config)) return config
  const line = `daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`
  const header = /^\[features\][ \t]*(#.*)?$/m.exec(config)
  if (header) {
    const at = header.index + header[0].length
    return `${config.slice(0, at)}\n${line}${config.slice(at)}`
  }
  const base = config.length === 0 || config.endsWith('\n') ? config : `${config}\n`
  return `${base}${base ? '\n' : ''}[features]\n${line}\n`
}

export function ensureCodexDaemonSocketGuard(homePath: string): void {
  const configPath = join(homePath, 'config.toml')
  try {
    // 共有のつもりでリンクにされていたら、リンク先（既定アカウント側）へは書かない
    if (lstatExists(configPath) && lstatSync(configPath).isSymbolicLink()) return
    const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    const next = applyCodexDaemonSocketGuard(current, homePath)
    if (next !== current) writeFileSync(configPath, next, { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    console.warn('[accounts] Codex のデーモン自動起動を切れませんでした', err)
    // config.toml の中身を含みうるので種類だけ
    reportHandled(errorKind(err), { area: 'accounts', op: 'guard codex daemon socket' })
  }
}
