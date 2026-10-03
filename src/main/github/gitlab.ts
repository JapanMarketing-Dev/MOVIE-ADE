import type { GitHubPostResult, GitHubPullRequest, GitHubRepoRef } from '@shared/github'
import type { GitLabAccount, GitLabStatus } from '@shared/forge'
import { cliInstallCommand } from '@shared/cliTools'
import type { GitHubRepoList } from '@shared/projectSource'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import { errorKind, reportHandled } from '@shared/report'
import { glab, redactGhOutput, type ExecResult } from './gh'
import {
  GITLAB_PROJECTS_ENDPOINT,
  glabApiArgs,
  mapGitLabProjects,
  mapMergeRequests,
  parseGlabAuthStatus,
  projectEndpoint,
  signedInHosts,
  webUrlFrom
} from './gitlabParse'

/**
 * GitLab 連携（gitlab.com とセルフホスト）。GitHub の gh と同じく、認証は GitLab CLI（glab）に任せる。
 * 本システムはトークンを読まず、保存もしない。
 * - 接続状態: `glab auth status --all`（古い glab は --all が無いので付けずにもう一度）
 * - 送信・一覧: `glab api --hostname <host>`。本文は JSON にして標準入力で渡す（引数の長さ制限と、ps に本文が出るのを避ける）
 */

type GlabRunner = (args: string[], options?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>

export type GlabErrorKind = 'missing' | 'timeout' | 'not-logged-in' | 'repo-not-found' | 'network' | 'failed'

/** glab の失敗を、決まった種類と画面に出せる短い文にする（トークンらしきものは伏せる） */
export function classifyGlabError(result: ExecResult): { kind: GlabErrorKind; message: string } {
  if (result.missing) return { kind: 'missing', message: t('gitlab.errors.glabMissing') }
  if (result.timedOut) return { kind: 'timeout', message: t('gitlab.errors.timeout') }
  const text = redactGhOutput(`${result.stderr}\n${result.stdout}`)
  if (/401|unauthorized|not logged in|no token|glab auth login|authenticat/i.test(text)) return { kind: 'not-logged-in', message: t('gitlab.errors.notLoggedIn') }
  if (/404|not found/i.test(text)) return { kind: 'repo-not-found', message: t('gitlab.errors.repoNotFound') }
  if (/network|dial tcp|timeout|could not connect|no such host/i.test(text)) return { kind: 'network', message: t('gitlab.errors.network') }
  const first = text.split('\n').map((l) => l.trim()).find(Boolean)
  return { kind: 'failed', message: first ? t('gitlab.errors.failedWith', { detail: first.slice(0, 200) }) : t('gitlab.errors.failed') }
}

function glabError(result: ExecResult): UserFacingError {
  return new UserFacingError(classifyGlabError(result).message)
}

// ─── 接続状態 ─────────────────────────────────────

let cached: { at: number; value: { installed: boolean; accounts: GitLabAccount[]; timedOut: boolean } } | null = null
const CACHE_MS = 60_000

/** glab に登録したホストとログインの状態。フッターの読み直し（30 秒ごと）で何度も glab を起こさないよう、少しの間は覚えておく */
export async function gitlabAccounts(run: GlabRunner = glab, fresh = false): Promise<{ installed: boolean; accounts: GitLabAccount[]; timedOut: boolean }> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  let result = await run(['auth', 'status', '--all'], { timeoutMs: 10_000 })
  if (result.failed && !result.missing && /unknown flag/i.test(`${result.stderr}\n${result.stdout}`)) {
    result = await run(['auth', 'status'], { timeoutMs: 10_000 })
  }
  const value = result.missing
    ? { installed: false, accounts: [], timedOut: false }
    : { installed: true, accounts: parseGlabAuthStatus(`${result.stdout}\n${result.stderr}`), timedOut: result.timedOut }
  cached = { at: Date.now(), value }
  return value
}

/** glab に登録してあるホスト（セルフホストの GitLab を見分けるため。ログインが切れていても GitLab であることは確か） */
export async function knownGitLabHosts(run: GlabRunner = glab): Promise<string[]> {
  return (await gitlabAccounts(run)).accounts.map((a) => a.host)
}

function envToken(): GitLabStatus['envToken'] {
  if (process.env.GITLAB_TOKEN) return 'GITLAB_TOKEN'
  if (process.env.GITLAB_ACCESS_TOKEN) return 'GITLAB_ACCESS_TOKEN'
  if (process.env.OAUTH_TOKEN) return 'OAUTH_TOKEN'
  return null
}

export async function gitlabStatus(projectRepo: GitHubRepoRef | null, run: GlabRunner = glab): Promise<GitLabStatus> {
  const { installed, accounts, timedOut } = await gitlabAccounts(run, true)
  return {
    glabInstalled: installed,
    accounts,
    envToken: envToken(),
    installCommand: cliInstallCommand('glab', process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux') ?? null,
    projectHost: projectRepo?.forge === 'gitlab' ? projectRepo.host : null,
    error: timedOut ? t('gitlab.errors.timeout') : null
  }
}

// ─── 「GitLab から取得」の一覧 ─────────────────────────

/** ログイン済みのホストごとに、自分がメンバーのプロジェクト（最大 100 件ずつ）。gh の一覧と同じ形で返す */
export async function listGitLabRepos(run: GlabRunner = glab): Promise<GitHubRepoList> {
  const { installed, accounts } = await gitlabAccounts(run, true)
  if (!installed) return { ghInstalled: false, loggedIn: false, repos: [] }
  const hosts = signedInHosts(accounts).slice(0, 5)
  if (hosts.length === 0) return { ghInstalled: true, loggedIn: false, repos: [] }
  const lists = await Promise.all(hosts.map(async (host) => {
    const result = await run(glabApiArgs(host, 'GET', GITLAB_PROJECTS_ENDPOINT), { timeoutMs: 30_000 })
    if (result.failed) return { error: classifyGlabError(result).message, repos: [] }
    try {
      return { error: null, repos: mapGitLabProjects(JSON.parse(result.stdout), host) }
    } catch (err) {
      reportHandled(errorKind(err), { area: 'github', op: 'parse gitlab projects' })
      return { error: null, repos: [] }
    }
  }))
  const repos = lists.flatMap((l) => l.repos)
  const error = repos.length === 0 ? lists.find((l) => l.error)?.error : undefined
  return { ghInstalled: true, loggedIn: true, repos, ...(error ? { error } : {}) }
}

// ─── レビュー結果の送り先 ───────────────────────────

function pathOf(repo: GitHubRepoRef): string {
  return `${repo.owner}/${repo.repo}`
}

/** コメント先の候補：自分が作った開いている MR。取れなければ空（Issue の作成はできる） */
export async function myOpenMergeRequests(repo: GitHubRepoRef, run: GlabRunner = glab): Promise<GitHubPullRequest[]> {
  const endpoint = `${projectEndpoint(pathOf(repo))}/merge_requests?state=opened&scope=created_by_me&order_by=updated_at&per_page=30`
  const result = await run(glabApiArgs(repo.host, 'GET', endpoint), { timeoutMs: 15_000 })
  if (result.failed) return []
  try {
    return mapMergeRequests(JSON.parse(result.stdout))
  } catch (err) {
    reportHandled(errorKind(err), { area: 'github', op: 'parse merge requests' })
    return []
  }
}

/** Issue を作る。題名と本文は JSON の値として標準入力で渡す */
export async function createGitLabIssue(repo: GitHubRepoRef, title: string, body: string, run: GlabRunner = glab): Promise<GitHubPostResult> {
  const result = await run(glabApiArgs(repo.host, 'POST', `${projectEndpoint(pathOf(repo))}/issues`, true), {
    input: JSON.stringify({ title, description: body }),
    timeoutMs: 30_000
  })
  if (result.failed) throw glabError(result)
  let url: string | null = null
  try { url = webUrlFrom(JSON.parse(result.stdout), repo.host) } catch { /* 作れたが、返事の形が違う */ }
  return { url: url ?? `${repo.webUrl}/-/issues` }
}

/** MR にコメントする（GitLab では note）。返事に URL は無いので、MR のページを返す */
export async function commentOnMergeRequest(repo: GitHubRepoRef, iid: number, body: string, run: GlabRunner = glab): Promise<GitHubPostResult> {
  if (!Number.isInteger(iid) || iid <= 0) throw new UserFacingError(t('github.errors.badTarget'))
  const result = await run(glabApiArgs(repo.host, 'POST', `${projectEndpoint(pathOf(repo))}/merge_requests/${iid}/notes`, true), {
    input: JSON.stringify({ body }),
    timeoutMs: 30_000
  })
  if (result.failed) throw glabError(result)
  return { url: `${repo.webUrl}/-/merge_requests/${iid}` }
}

/** テスト用：覚えた状態を消す */
export function resetGitLabCache(): void {
  cached = null
}
