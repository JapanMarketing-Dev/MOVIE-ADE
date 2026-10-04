import type { AgentAccountsSettings } from '@shared/accounts'
import type { AccountAgent } from '@shared/types'
import { ensureCodexDaemonSocketGuard, linkSharedEntries, migrateManagedClaudeDir } from './agentConfig'
import { assertManagedAccountDir, systemConfigDir } from './paths'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'

/**
 * 選択中のアカウントを、Agent の子プロセスへ渡す環境変数にする。
 *
 * Orca由来: ~/bench/orca/src/main/claude-accounts/environment.ts（applyClaudeEnvPatch / CLAUDE_AUTH_ENV_VARS）,
 *           ~/bench/orca/src/main/codex-accounts/runtime-home-service-launch.ts の考え方（MIT, Copyright 2026 Lovecast Inc.）
 *
 * - システムの既定アカウントなら何も足さない（利用者の環境変数をそのまま使う）
 * - Codex の管理アカウントなら CODEX_HOME、Claude なら CLAUDE_CONFIG_DIR をそのフォルダにする
 * - Claude の管理アカウントのときは、環境にある Anthropic の認証用変数を空にする
 *   （残っていると選んだアカウントではなく、その鍵で動いてしまう。Orca の stripAuthEnv と同じ）
 * - フォルダが確かめられないときは既定アカウントへ黙って戻さず、理由つきで止める
 *   （別のアカウントで動いて請求先を取り違えないため）
 */

const CLAUDE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK'
] as const

const AGENT_ACCOUNT_ENV_KEY: Record<AccountAgent, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME'
}

export function resolveAgentEnvFrom(options: {
  agent: AccountAgent
  accounts: AgentAccountsSettings | undefined
  userDataDir: string
  baseEnv?: NodeJS.ProcessEnv
  accountId?: string | null
  /** 既定アカウントの設定フォルダ（テスト用。省略時は ~/.claude など） */
  systemDir?: string
}): Record<string, string> {
  const { agent, userDataDir } = options
  const list = options.accounts?.[agent]
  const accountId = options.accountId !== undefined ? options.accountId : (list?.activeAccountId ?? null)
  if (!accountId) return {}
  if (options.accountId === undefined && !list?.accounts.some((a) => a.id === accountId)) return {}
  let dir: string
  try {
    dir = assertManagedAccountDir({ userDataDir, agent, accountId })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new UserFacingError(t('accounts.errors.unusable', { agent: agent === 'claude' ? 'Claude Code' : 'Codex', reason }))
  }
  const env: Record<string, string> = { [AGENT_ACCOUNT_ENV_KEY[agent]]: dir }
  if (agent === 'claude') {
    // 以前に追加したアカウントにも、権限確認を省くモードの同意などを起動の前に1回だけ引き継ぐ
    migrateManagedClaudeDir(dir, options.systemDir ?? systemConfigDir('claude'))
    const base = options.baseEnv ?? process.env
    for (const key of CLAUDE_AUTH_ENV_VARS) if (base[key]) env[key] = ''
  } else {
    // 管理フォルダのパスが長いと Codex のデーモン用ソケットが作れない。起動のたびに確かめる
    ensureCodexDaemonSocketGuard(dir)
    // あとから共有に足した項目（rules など）を、以前に追加したアカウントにも張る
    linkSharedEntries('codex', dir, options.systemDir ?? systemConfigDir('codex'))
  }
  return env
}
