import type { AccountAgent } from './types'
import { t } from './i18n'

/**
 * Claude Code / Codex のアカウント切り替え（main / renderer が共有する型）。
 *
 * Orca由来: ~/bench/orca/src/shared/managed-account-types.ts（MIT, Copyright 2026 Lovecast Inc.）
 * Orca の CodexManagedAccount / ClaudeManagedAccount を1つの形にまとめた。
 * WSL・リモート実行・組織情報は扱わないので持ち込んでいない。
 *
 * アカウントごとに専用の設定フォルダ（Codex は CODEX_HOME、Claude は CLAUDE_CONFIG_DIR）を持ち、
 * 置き場所は app.getPath('userData')/accounts/<agent>/<id>/ に固定する。
 * パスは保存せず id から毎回決める（設定ファイルを書き換えて任意のフォルダを指させないため）。
 */

/** 保存する1アカウント分 */
export interface AgentAccount {
  id: string
  /** 利用者が付けた名前。空ならメールアドレスを表示に使う */
  label: string
  /** ログイン後に設定フォルダから読み取ったメールアドレス。未ログインなら null */
  email: string | null
  /** プラン・ワークスペース名（Codex の Personal (Plus) や Claude の組織名など） */
  workspaceLabel: string | null
  createdAt: number
  updatedAt: number
  /** ログインが済んだことを最後に確かめた時刻。追加直後（ログイン待ち）は null */
  lastAuthenticatedAt: number | null
}

/** Agent ごとの一覧と選択。activeAccountId が null なら「システムの既定アカウント」 */
export interface AgentAccountList {
  accounts: AgentAccount[]
  activeAccountId: string | null
}

export type AgentAccountsSettings = Record<AccountAgent, AgentAccountList>

export const EMPTY_AGENT_ACCOUNTS: AgentAccountsSettings = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null }
}

/** 画面に出す1アカウント分。ログイン状態は設定フォルダを見て毎回決める */
export interface AgentAccountSummary extends AgentAccount {
  /** 認証情報が設定フォルダにある */
  signedIn: boolean
  /** 設定フォルダが見つからない・本システムの物でないなど、使えない理由 */
  problem: string | null
}

/**
 * システムの既定アカウント（~/.claude・~/.codex）の読み取り結果。
 * Orca の CodexSystemDefaultIdentity と同じく、表示のために読むだけで書き換えない。
 */
interface SystemDefaultAccount {
  signedIn: boolean
  email: string | null
}

export interface AgentAccountsView {
  accounts: AgentAccountSummary[]
  activeAccountId: string | null
  systemDefault: SystemDefaultAccount
}

export type AgentAccountsState = Record<AccountAgent, AgentAccountsView>

/** 追加の結果。続けて内蔵ターミナルでログインを始めるための情報を添える */
export interface AgentAccountAddResult {
  state: AgentAccountsState
  login: AccountLoginRequest
}

/** 内蔵ターミナルでアカウントのログインを始める指定 */
export interface AccountLoginRequest {
  agent: AccountAgent
  accountId: string
}

/** 表示名。名前 → メール → 「ログイン待ち」の順 */
export function accountDisplayName(account: Pick<AgentAccount, 'label' | 'email'>): string {
  return account.label.trim() || account.email || t('accounts.pendingLabel')
}
