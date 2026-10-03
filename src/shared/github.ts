import { forgeBranchUrl, type Forge } from './forge'

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

export interface GitHubPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  url: string
  updatedAt: string
  headRefName: string
}

/** レビュー結果を GitHub へ送る前の下書き。画面で送り先と本文を見せてから送る */
export interface GitHubReviewDraft {
  repo: GitHubRepoRef
  title: string
  body: string
  /** コメント先の候補（自分の開いている PR） */
  pullRequests: GitHubPullRequest[]
}

export type GitHubReviewTarget = { kind: 'issue'; title: string } | { kind: 'pr-comment'; number: number }

export interface GitHubPostResult {
  /** 作った Issue・コメントのURL */
  url: string
}

/** フッターに出す、今のプロジェクトのリポジトリとブランチ */
export interface GitRepoStatus {
  /** git のリポジトリか。false なら項目を隠す */
  isGit: boolean
  /** origin が GitHub のとき。それ以外の remote・remote なしは null */
  repo: GitHubRepoRef | null
  /** ブランチ名。detached HEAD のときは null で、shortOid を出す */
  branch: string | null
  shortOid: string | null
  /** 未コミットの変更（追跡外を含む）のファイル数 */
  changes: number
  ahead: number
  behind: number
  hasUpstream: boolean
}

/** GitHub / GitLab のブランチのページ。ブランチ名の「/」は区切りのまま残す */
export function branchWebUrl(repo: GitHubRepoRef, branch: string): string {
  return forgeBranchUrl(repo.webUrl, repo.forge ?? 'github', branch)
}
