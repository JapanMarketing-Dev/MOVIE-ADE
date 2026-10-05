import { forgeBranchUrl, type Forge } from './forge'
import type { GitStatusSummary, GitSyncAction, GitSyncErrorKind } from './gitSync'

/**
 * GitHub 連携の型（main と renderer で共有する）。
 *
 * Orca と同じく、認証は GitHub CLI（gh）に任せる。本システムはトークンを持たず、
 * 画面にもログにも出さない。gh が無い・未ログインのときは、その旨と次の一手を返す。
 */

/** `gh auth status` の1アカウント分。トークンそのものは入れない */
export interface GitHubAccount {
  host: string
  user: string
  /** そのホストで今使われているアカウントか */
  active: boolean
  /** キーリングに保存したログインか、環境変数（GH_TOKEN / GITHUB_TOKEN）か */
  source: 'keyring' | 'env'
  scopes: string[]
}

export interface GitHubStatus {
  /** gh が見つかったか。false のときは installHint を出す */
  ghInstalled: boolean
  /** 今使われているアカウント。null は未ログイン */
  account: GitHubAccount | null
  accounts: GitHubAccount[]
  /** ADE のプロセスに GH_TOKEN / GITHUB_TOKEN が入っていて、キーリングより優先される */
  envToken: 'GH_TOKEN' | 'GITHUB_TOKEN' | null
  /** gh が無いときの入れ方（OS ごと） */
  installHint: string
  /** 調べられなかった理由（タイムアウトなど）。正常なら null */
  error: string | null
}

/** プロジェクトの origin から求めた GitHub / GitLab のリポジトリ */
export interface GitHubRepoRef {
  host: string
  /** GitLab ではサブグループを含む（group/sub） */
  owner: string
  repo: string
  /** ブラウザで開くURL（https://github.com/owner/repo） */
  webUrl: string
  /** 無ければ GitHub（今までの値との互換） */
  forge?: Forge
}

export interface GitHubRepoResult {
  repo: GitHubRepoRef | null
  /** repo が null の理由（プロジェクト未選択・git でない・origin が GitHub でない など） */
  reason: string | null
}

/** フッターに出す、今のプロジェクトのリポジトリとブランチ */
export interface GitRepoStatus extends GitStatusSummary {
  /** git のリポジトリか。false なら項目を隠す */
  isGit: boolean
  /** origin が GitHub / GitLab のとき。それ以外の remote・remote なしは null */
  repo: GitHubRepoRef | null
  /** fetch できるリモートがあるか（upstream があるか、origin がある） */
  hasRemote: boolean
  /** 裏の fetch の様子（取得中・最後に取得した時刻・最後の失敗） */
  fetch: GitFetchView
  /** 走っている操作（最新の取得・push）。無ければ null */
  busy: GitSyncAction | null
}

export interface GitFetchView {
  fetching: boolean
  lastFetchAt: number | null
  lastError: GitSyncErrorKind | null
}

/** フッターの「リモートの変更を確認」「最新を取得」「push」の結果 */
export interface GitActionResult {
  ok: boolean
  action: GitSyncAction
  /** 失敗・取り込まなかった理由 */
  error: GitSyncErrorKind | null
  /** error が failed のときだけ、git の出力の1行目（トークン・URL の認証情報は伏せる） */
  detail: string | null
  /** 取り込んだコミットの数（pull）・push したコミットの数（push） */
  commits: number
  status: GitRepoStatus
}

/** GitHub / GitLab のブランチのページ。ブランチ名の「/」は区切りのまま残す */
export function branchWebUrl(repo: GitHubRepoRef, branch: string): string {
  return forgeBranchUrl(repo.webUrl, repo.forge ?? 'github', branch)
}
