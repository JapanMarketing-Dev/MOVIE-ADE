import { readFile } from 'node:fs/promises'
import type {
  GitHubPostResult,
  GitHubPullRequest,
  GitHubRepoRef,
  GitHubRepoResult,
  GitHubReviewDraft,
  GitHubReviewTarget,
  GitHubStatus
} from '@shared/github'
import type { SessionPaths } from '../sessions/paths'
import { gh, ghErrorMessage, run } from './gh'
import { issueFromFeedback, mapPullRequests, parseAuthStatus, parseGitRemote, pickActiveAccount } from './parse'
import { formatNumber, t } from '@shared/i18n'

/**
 * GitHub 連携（設定の「GitHub」欄と、レビュー結果の送り先）。
 *
 * Orca と同じく GitHub CLI（gh）に認証を任せる。本システムはトークンを読まず、保存もしない。
 * - 接続状態: `gh auth status` を読む（Orca由来: ~/bench/orca/src/main/github/auth-diagnose.ts の diagnoseGhAuth（MIT））
 * - リポジトリ: プロジェクトフォルダの `git remote get-url origin`
 * - コメント先の候補: `gh pr list --json`
 * - 送信: `gh issue create` / `gh pr comment`。本文は標準入力で渡す（引数の長さ制限と、ps に本文が出るのを避ける）
 */

const PR_LIMIT = 30
/** GitHub の本文の上限は 65536 文字。余裕を見て切る */
const BODY_MAX = 60_000

function installHint(): string {
  if (process.platform === 'darwin') return 'brew install gh'
  if (process.platform === 'win32') return 'winget install --id GitHub.cli'
  return t('github.errors.installHint')
}

export async function githubStatus(): Promise<GitHubStatus> {
  const envToken = process.env.GH_TOKEN ? 'GH_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null
  const base = { envToken, installHint: installHint() } as const
  // 未ログインだと 1 で終わるが、診断の文は同じように出るので両方の出力を読む
  const result = await gh(['auth', 'status'], { timeoutMs: 10_000 })
  if (result.missing) return { ...base, ghInstalled: false, account: null, accounts: [], error: null }
  const accounts = parseAuthStatus(`${result.stdout}\n${result.stderr}`)
  return {
    ...base,
    ghInstalled: true,
    account: pickActiveAccount(accounts, 'github.com') ?? pickActiveAccount(accounts),
    accounts,
    error: result.timedOut ? ghErrorMessage(result) : null
  }
}

export async function githubRepo(folderPath: string | null): Promise<GitHubRepoResult> {
  if (!folderPath) return { repo: null, reason: t('github.errors.openProject') }
  const result = await run('git', ['-C', folderPath, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 })
  if (result.missing) return { repo: null, reason: t('github.errors.gitMissing') }
  if (result.failed) {
    return { repo: null, reason: /not a git repository/i.test(result.stderr) ? t('github.errors.notGitRepo') : t('github.errors.noOrigin') }
  }
  const repo = parseGitRemote(result.stdout)
  return repo ? { repo, reason: null } : { repo: null, reason: t('github.errors.originNotGitHub') }
}

/** gh の --repo 指定。github.com 以外（GHES）はホスト付きで渡す */
function repoArg(repo: GitHubRepoRef): string {
  return repo.host === 'github.com' ? `${repo.owner}/${repo.repo}` : `${repo.host}/${repo.owner}/${repo.repo}`
}

/** コメント先の候補：自分が作った開いている PR。取れなければ空（Issue の作成はできる） */
async function myOpenPullRequests(repo: GitHubRepoRef, folderPath: string | null): Promise<GitHubPullRequest[]> {
  const result = await gh([
    'pr', 'list', '--repo', repoArg(repo), '--author', '@me', '--state', 'open',
    '--json', 'number,title,state,url,isDraft,updatedAt,headRefName', '--limit', String(PR_LIMIT)
  ], { cwd: folderPath ?? undefined })
  if (result.failed) return []
  try {
    return mapPullRequests(JSON.parse(result.stdout))
  } catch {
    return []
  }
}

async function requireRepo(folderPath: string | null): Promise<GitHubRepoRef> {
  const { repo, reason } = await githubRepo(folderPath)
  if (!repo) throw new Error(reason ?? t('github.errors.repoUnknown'))
  return repo
}

/** 送る前の下書き。画面で送り先と本文を見せるためのもので、GitHub には何も書かない */
export async function githubReviewDraft(paths: SessionPaths, folderPath: string | null): Promise<GitHubReviewDraft> {
  const repo = await requireRepo(folderPath)
  let markdown: string
  try {
    markdown = await readFile(paths.feedbackMd, 'utf8')
  } catch {
    throw new Error(t('github.errors.feedbackMissing'))
  }
  const { title, body } = issueFromFeedback(markdown)
  return { repo, title, body, pullRequests: await myOpenPullRequests(repo, folderPath) }
}

/**
 * レビュー結果を GitHub に書き込む（Issue を作る / PR にコメントする）。
 * 画面の確認ダイアログで送り先と本文を見せ、利用者が押したときだけ呼ばれる。
 */
export async function githubPostReview(folderPath: string | null, target: GitHubReviewTarget, body: string): Promise<GitHubPostResult> {
  const repo = await requireRepo(folderPath)
  const text = String(body ?? '').trim()
  if (!text) throw new Error(t('github.errors.bodyEmpty'))
  if (text.length > BODY_MAX) throw new Error(t('github.errors.bodyTooLong', { max: formatNumber(BODY_MAX) }))
  let args: string[]
  if (target?.kind === 'issue') {
    const title = String(target.title ?? '').trim().slice(0, 256)
    if (!title) throw new Error(t('github.errors.titleRequired'))
    args = ['issue', 'create', '--repo', repoArg(repo), '--title', title, '--body-file', '-']
  } else if (target?.kind === 'pr-comment' && Number.isInteger(target.number) && target.number > 0) {
    args = ['pr', 'comment', String(target.number), '--repo', repoArg(repo), '--body-file', '-']
  } else {
    throw new Error(t('github.errors.badTarget'))
  }
  const result = await gh(args, { cwd: folderPath ?? undefined, input: text, timeoutMs: 30_000 })
  if (result.failed) throw new Error(ghErrorMessage(result))
  const url = result.stdout.match(/https?:\/\/\S+/)?.[0] ?? repo.webUrl
  return { url }
}
