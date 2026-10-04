import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { app } from 'electron'
import {
  EMPTY_AGENT_ACCOUNTS,
  type AccountLoginRequest,
  type AgentAccount,
  type AgentAccountAddResult,
  type AgentAccountsSettings,
  type AgentAccountsState,
  type AgentAccountsView
} from '@shared/accounts'
import { TUI_AGENT_LABEL, type AccountAgent, type TuiAgent } from '@shared/types'
import { isAccountAgent } from '@shared/agentCatalog'
import type { AgentStartupShell } from '@shared/agentLaunch'
import { canonicalLaunchCommand } from '@shared/agentPolicy'
import { currentSettings, updateSettings } from '../settings'
import { seedManagedAccountDir } from './agentConfig'
import { resolveAgentEnvFrom } from './env'
import { claudeKeychainService, readClaudeIdentity, readClaudeSystemIdentity, readCodexIdentity, type AccountIdentity } from './identity'
import { createManagedAccountDir, isValidAccountId, removeManagedAccountDir, systemConfigDir, verifyManagedAccountDir } from './paths'
import { normalizeAccountLabel } from './sanitize'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { errorKind, reportHandled } from '@shared/report'

/**
 * アカウントの一覧・追加・名前の変更・削除・選択（IPC の受け口）。
 *
 * Orca由来: ~/bench/orca/src/main/codex-accounts/service.ts,
 *           ~/bench/orca/src/main/codex-accounts/codex-account-selection.ts,
 *           ~/bench/orca/src/main/codex-accounts/codex-account-registration.ts,
 *           ~/bench/orca/src/main/claude-accounts/claude-account-registration.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca との違い:
 * - Orca は「追加」で裏の子プロセスとして `codex login` / `claude auth login` を走らせ、
 *   終わってから一覧へ登録する。本システムは内蔵ターミナルでログインを見せたいので、
 *   先に設定フォルダと「ログイン待ち」の行を作り、一覧を読むたびに設定フォルダを見て登録を完了させる。
 * - ログインが終わった新しいアカウントを、Codex は選択中にし、Claude は選択を変えない（Orca と同じ）。
 * - 切り替えは新しく開く Agent から効く。動いている Agent の環境変数は変えられない（Orca と同じ）。
 */

function userDataDir(): string {
  return app.getPath('userData')
}

function accountsSettings(): AgentAccountsSettings {
  return currentSettings().agentAccounts ?? EMPTY_AGENT_ACCOUNTS
}

function saveList(agent: AccountAgent, next: AgentAccountsSettings[AccountAgent]): void {
  updateSettings({ agentAccounts: { ...accountsSettings(), [agent]: next } })
}

function requireAccount(agent: AccountAgent, accountId: string): AgentAccount {
  const account = accountsSettings()[agent].accounts.find((a) => a.id === accountId)
  if (!account) throw new UserFacingError(t('accounts.errors.gone'))
  return account
}

// Orca と同じく、設定の読み書きが重なって更新を取りこぼさないよう1本の列に並べる
let mutationQueue: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(fn, fn)
  // 失敗は next の呼び出し側へ返す。ここは順番待ちに使うだけ（想定内）
  mutationQueue = next.catch(() => undefined)
  return next
}

async function readIdentity(agent: AccountAgent, dir: string): Promise<AccountIdentity> {
  return agent === 'codex' ? readCodexIdentity(dir) : readClaudeIdentity(dir)
}

async function readSystemDefault(agent: AccountAgent): Promise<AccountIdentity> {
  return agent === 'codex' ? readCodexIdentity(systemConfigDir('codex')) : readClaudeSystemIdentity()
}

/** 1つの Agent 分を読む。ログインが済んだ行はメールなどを書き戻す */
async function refreshAgent(agent: AccountAgent): Promise<AgentAccountsView> {
  const list = accountsSettings()[agent]
  const now = Date.now()
  let changed = false
  let activeAccountId = list.activeAccountId
  const summaries = await Promise.all(
    list.accounts.map(async (account) => {
      const verdict = verifyManagedAccountDir({ userDataDir: userDataDir(), agent, accountId: account.id })
      if (verdict.kind !== 'owned') return { account, signedIn: false, problem: verdict.reason }
      const identity = await readIdentity(agent, verdict.dir)
      let next = account
      if (identity.signedIn) {
        const firstLogin = account.lastAuthenticatedAt === null
        if (firstLogin || identity.email !== account.email || identity.workspaceLabel !== account.workspaceLabel) {
          next = {
            ...account,
            email: identity.email ?? account.email,
            workspaceLabel: identity.workspaceLabel,
            updatedAt: now,
            lastAuthenticatedAt: firstLogin ? now : account.lastAuthenticatedAt
          }
          changed = true
          // Orca の Codex は追加したアカウントをそのまま選択中にする（Claude は変えない）
          if (firstLogin && agent === 'codex') activeAccountId = account.id
        }
      }
      return { account: next, signedIn: identity.signedIn, problem: null }
    })
  )
  const accounts = summaries.map((s) => s.account)
  if (changed) saveList(agent, { accounts, activeAccountId })
  const systemDefault = await readSystemDefault(agent)
  return {
    accounts: summaries
      .map((s) => ({ ...s.account, signedIn: s.signedIn, problem: s.problem }))
      .sort((a, b) => a.createdAt - b.createdAt),
    activeAccountId,
    systemDefault: { signedIn: systemDefault.signedIn, email: systemDefault.email }
  }
}

export function listAgentAccounts(): Promise<AgentAccountsState> {
  return serialize(async () => {
    const [claude, codex] = await Promise.all([refreshAgent('claude'), refreshAgent('codex')])
    return { claude, codex }
  })
}

/**
 * 新しい設定フォルダと「ログイン待ち」の行を作る。
 * 続けて renderer が内蔵ターミナルでログインを始める（Orca の add → login の流れを分けたもの）。
 */
export async function addAgentAccount(agent: AccountAgent): Promise<AgentAccountAddResult> {
  const login = await serialize(async (): Promise<AccountLoginRequest> => {
    const accountId = randomUUID()
    const dir = createManagedAccountDir(userDataDir(), agent, accountId)
    seedManagedAccountDir(agent, dir, systemConfigDir(agent))
    const now = Date.now()
    const list = accountsSettings()[agent]
    saveList(agent, {
      ...list,
      accounts: [
        ...list.accounts,
        { id: accountId, label: '', email: null, workspaceLabel: null, createdAt: now, updatedAt: now, lastAuthenticatedAt: null }
      ]
    })
    return { agent, accountId }
  })
  return { state: await listAgentAccounts(), login }
}

export async function renameAgentAccount(agent: AccountAgent, accountId: string, label: string): Promise<AgentAccountsState> {
  await serialize(async () => {
    requireAccount(agent, accountId)
    const list = accountsSettings()[agent]
    saveList(agent, {
      ...list,
      accounts: list.accounts.map((a) => (a.id === accountId ? { ...a, label: normalizeAccountLabel(label), updatedAt: Date.now() } : a))
    })
  })
  return listAgentAccounts()
}

/**
 * 一覧から外し、設定フォルダを消す。本システムの物だと確かめられないフォルダは消さない。
 * macOS では、そのフォルダ用に Claude Code が作った Keychain の項目も消す
 * （フォルダ名から決まる項目だけ。既定アカウントの無印の項目には触らない）。
 * サーバー側のログアウトはしない。
 */
export async function removeAgentAccount(agent: AccountAgent, accountId: string): Promise<AgentAccountsState> {
  await serialize(async () => {
    requireAccount(agent, accountId)
    const verdict = verifyManagedAccountDir({ userDataDir: userDataDir(), agent, accountId })
    // 先にフォルダを消す。消せなければ（Windows でファイルが使われている等）一覧に残して知らせる。
    // 一覧から先に外すと、認証情報の入ったフォルダが残ったまま消す手段が無くなる（Orca #11653）
    if (verdict.kind === 'owned') {
      if (agent === 'claude') await deleteScopedClaudeKeychainItem(verdict.dir)
      try {
        removeManagedAccountDir(userDataDir(), agent, accountId)
      } catch (err) {
        reportHandled(errorKind(err), { area: 'accounts', op: 'remove account folder' })
        throw new UserFacingError(t('accounts.errors.removeFailed', { agent: agent === 'claude' ? 'Claude Code' : 'Codex', reason: errorKind(err).message }))
      }
    }
    const list = accountsSettings()[agent]
    saveList(agent, {
      accounts: list.accounts.filter((a) => a.id !== accountId),
      activeAccountId: list.activeAccountId === accountId ? null : list.activeAccountId
    })
  })
  return listAgentAccounts()
}

function deleteScopedClaudeKeychainItem(configDir: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve()
  const service = claudeKeychainService(configDir)
  let user = 'claude-code-user'
  try {
    const raw = process.env.USER || userInfo().username
    if (/^[a-zA-Z0-9._-]+$/.test(raw)) user = raw
  } catch {
    // 既定の利用者名で消す
  }
  return new Promise((resolve) => {
    execFile('security', ['delete-generic-password', '-s', service, '-a', user], { timeout: 5000 }, () => resolve())
  })
}

/** null を選ぶとシステムの既定アカウントへ戻す。ログインが済んでいないアカウントは選べない */
export async function selectAgentAccount(agent: AccountAgent, accountId: string | null): Promise<AgentAccountsState> {
  await serialize(async () => {
    const list = accountsSettings()[agent]
    if (accountId !== null) {
      requireAccount(agent, accountId)
      const verdict = verifyManagedAccountDir({ userDataDir: userDataDir(), agent, accountId })
      if (verdict.kind !== 'owned') throw new Error(verdict.reason)
      if (!(await readIdentity(agent, verdict.dir)).signedIn) {
        throw new UserFacingError(t('accounts.errors.notSignedIn'))
      }
    }
    saveList(agent, { ...list, activeAccountId: accountId })
  })
  return listAgentAccounts()
}

/** 再ログイン（ログイン待ちのままのものや、期限切れのもの）。行はそのままでログインだけ始める */
export function reloginAgentAccount(agent: AccountAgent, accountId: string): AccountLoginRequest {
  requireAccount(agent, accountId)
  return { agent, accountId }
}

/**
 * 内蔵ターミナルで Agent を起動するとき・「指摘を整理」で CLI を動かすときに渡す環境変数。
 * システムの既定アカウントなら {}。
 */
export function resolveAgentEnv(agent: TuiAgent): Record<string, string> {
  // アカウントを切り替えられるのは Claude Code / Codex だけ。ほかのエージェントは環境変数を足さない
  if (!isAccountAgent(agent)) return {}
  return resolveAgentEnvFrom({ agent, accounts: currentSettings().agentAccounts, userDataDir: userDataDir() })
}

/** ログイン用のコマンド（Orca の runClaudeLoginSession / runCodexLoginSession と同じサブコマンド） */
const LOGIN_ARGS: Record<AccountAgent, string> = {
  claude: 'auth login --claudeai',
  codex: 'login'
}

/**
 * 内蔵ターミナルでアカウントのログインを始めるための、起動の語（argv）・環境変数・タブ名。
 * コマンド本体は Agent 設定の command（利用者が変えていればそれ）を使う。Agent の起動と同じく一度だけ語に分け、
 * コマンドの欄に権限やフォルダの信頼のフラグがあれば始めない（security-5 [2]）
 */
export function buildAccountLoginLaunch(
  req: AccountLoginRequest,
  shell: AgentStartupShell
): { argv: string[]; env: Record<string, string>; title: string } {
  const { agent, accountId } = req
  if (!isValidAccountId(accountId)) throw new UserFacingError(t('accounts.errors.invalidId'))
  requireAccount(agent, accountId)
  const env = resolveAgentEnvFrom({ agent, accounts: accountsSettings(), userDataDir: userDataDir(), accountId })
  const title = t('accounts.loginTabTitle', { agent: TUI_AGENT_LABEL[agent] })
  const command = canonicalLaunchCommand(agent, currentSettings().agents.launch[agent]?.command ?? '', shell)
  if (!command.ok) throw new UserFacingError(t('terminal.errors.launch', { agent: TUI_AGENT_LABEL[agent], error: command.error }))
  return { argv: [...command.words.map((word) => word.value), ...LOGIN_ARGS[agent].split(' ')], env, title }
}
