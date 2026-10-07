import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import {
  buildRepoCreateArgs, isValidOwner, isValidRepoName, sanitizeDescription, splitInitialCommitFiles, suggestRepoName,
  type RepoCreateInfo, type RepoCreateRequest, type RepoCreateResult
} from '@shared/repoCreate'
import { classifyGhError, gh, redactGhOutput, type ExecResult } from './gh'
import { AUTOMATIC_GIT_CONFIG, gitSyncEnv, trustedGit } from './gitSync'

/**
 * プロジェクトの右クリックの「GitHub で private リポジトリを作る」。
 *
 * - 作るのは private だけ（@shared/repoCreate の buildRepoCreateArgs が --private を付ける）。gh は shell を通さずに起動する（gh.ts）
 * - フォルダが git でなければ git init（既定のブランチは main）。コミットが無ければ、.gitignore の対象と秘密らしいファイル
 *   （.env・鍵など）を除いて最初のコミットを作る。外したものは .git/info/exclude に書く（プロジェクトのファイルは変えない）
 * - origin が既にある・別のリポジトリの中のフォルダ・同じ名前のリポジトリがあるときは作らずに断る
 * - git は信頼できる絶対パスで起動し（gitSync.ts の trustedGit）、フック・fsmonitor を動かさない（AUTOMATIC_GIT_CONFIG）
 */

const GIT_TIMEOUT_MS = 30_000
const CREATE_TIMEOUT_MS = 180_000
/** 最初のコミットに入れるファイルの数の上限（node_modules を .gitignore に書き忘れたフォルダなど）。超えたら作らずに知らせる */
const MAX_INITIAL_FILES = 20_000

interface GitResult { stdout: string; stderr: string; failed: boolean }

function runGit(git: string, args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(git, [...AUTOMATIC_GIT_CONFIG, ...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: gitSyncEnv() },
      (err, stdout, stderr) => resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), failed: Boolean(err) }))
  })
}

function failed(message: string): never {
  throw new UserFacingError(message)
}

interface FolderState {
  git: string
  isGit: boolean
  hasCommits: boolean
  hasOrigin: boolean
}

async function folderState(folder: string): Promise<FolderState> {
  const git = await trustedGit(folder)
  if (!git) failed(t('repoCreate.errors.gitMissing'))
  const top = await runGit(git, ['rev-parse', '--show-toplevel'], folder)
  let isGit = false
  if (!top.failed) {
    const [a, b] = await Promise.all([realpath(top.stdout.trim()).catch(() => top.stdout.trim()), realpath(folder).catch(() => folder)])
    // 親のフォルダのリポジトリの中（モノレポの一部など）には作らない（親のリポジトリの origin を書き換えてしまう）
    if (a !== b) failed(t('repoCreate.errors.insideOtherRepo'))
    isGit = true
  }
  const hasCommits = isGit && !(await runGit(git, ['rev-parse', '--verify', '--quiet', 'HEAD'], folder)).failed
  const hasOrigin = isGit && !(await runGit(git, ['remote', 'get-url', 'origin'], folder)).failed
  return { git, isGit, hasCommits, hasOrigin }
}

/** 最初のコミットに入るファイル（.gitignore の対象を除く）。git でないフォルダは一時の空のリポジトリから見る（フォルダには何も作らない） */
async function candidateFiles(git: string, folder: string, isGit: boolean): Promise<string[]> {
  let scratch: string | null = null
  try {
    const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    let result: GitResult
    if (isGit) {
      result = await runGit(git, args, folder)
    } else {
      scratch = await mkdtemp(join(tmpdir(), 'ferret-repo-'))
      const init = await runGit(git, ['init', '-q', scratch], tmpdir())
      if (init.failed) failed(t('repoCreate.errors.gitFailed'))
      result = await runGit(git, [`--git-dir=${join(scratch, '.git')}`, `--work-tree=${folder}`, ...args], folder)
    }
    if (result.failed) failed(t('repoCreate.errors.gitFailed'))
    return [...new Set(result.stdout.split('\0').filter(Boolean))]
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}

async function ghReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const status = await gh(['auth', 'status', '--hostname', 'github.com'])
  if (status.missing) return { ok: false, reason: t('github.errors.ghMissing') }
  if (status.failed) return { ok: false, reason: t('github.errors.notLoggedIn') }
  return { ok: true }
}

async function ghLines(args: string[]): Promise<string[]> {
  const result = await gh(args, { timeoutMs: 20_000 })
  if (result.failed) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(isValidOwner)
}

/** 右クリックで開くダイアログの下調べ（何も変えない） */
export async function repoCreateInfo(folder: string, defaultOwner: string | undefined): Promise<RepoCreateInfo> {
  const state = await folderState(folder)
  const files = state.hasCommits ? [] : await candidateFiles(state.git, folder, state.isGit)
  const { included, excluded } = splitInitialCommitFiles(files)
  const base: RepoCreateInfo = {
    ready: false, login: null, orgs: [], defaultOwner: null, suggestedName: suggestRepoName(basename(folder)),
    isGit: state.isGit, hasCommits: state.hasCommits, hasOrigin: state.hasOrigin,
    initialFiles: included.length, excludedSecrets: excluded.slice(0, 20)
  }
  const ready = await ghReady()
  if (!ready.ok) return { ...base, reason: ready.reason }
  const [login] = await ghLines(['api', 'user', '--jq', '.login'])
  if (!login) return { ...base, reason: t('github.errors.notLoggedIn') }
  const orgs = await ghLines(['api', 'user/orgs', '--paginate', '--jq', '.[].login'])
  const owners = [login, ...orgs]
  const owner = defaultOwner && owners.some((o) => o.toLowerCase() === defaultOwner.toLowerCase()) ? defaultOwner : login
  return { ...base, ready: true, login, orgs, defaultOwner: owner }
}

/** exclude のファイルに書く1行（先頭の / でこのパスだけ。グロブの文字はそのままの文字にする） */
function excludeLine(path: string): string {
  return `/${path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/^ | $/g, '\\ ')}`
}

function createError(result: ExecResult): never {
  const text = redactGhOutput(`${result.stderr}\n${result.stdout}`)
  if (/name already exists/i.test(text)) failed(t('repoCreate.errors.exists'))
  failed(classifyGhError(result).message)
}

/** 作る。押したあとの確認ダイアログで owner / name / private を見せてから呼ぶ */
export async function createPrivateRepo(folder: string, request: RepoCreateRequest): Promise<RepoCreateResult> {
  if (!isValidOwner(request.owner)) failed(t('repoCreate.errors.owner'))
  if (!isValidRepoName(request.name)) failed(t('repoCreate.errors.name'))
  const ready = await ghReady()
  if (!ready.ok) failed(ready.reason)
  let state = await folderState(folder)
  if (state.hasOrigin) failed(t('repoCreate.errors.hasOrigin'))
  const { git } = state
  if (!state.isGit) {
    const init = await runGit(git, ['init', '-q', '-b', 'main'], folder)
    if (init.failed) failed(t('repoCreate.errors.gitFailed'))
    state = { ...state, isGit: true }
  }
  let excludedCount = 0
  let committed = state.hasCommits
  if (!state.hasCommits && request.initialCommit) {
    const { included, excluded } = splitInitialCommitFiles(await candidateFiles(git, folder, true))
    if (included.length > MAX_INITIAL_FILES) failed(t('repoCreate.errors.tooManyFiles', { count: included.length.toLocaleString() }))
    excludedCount = excluded.length
    if (excluded.length > 0) {
      // .gitignore は変えず、このパソコンのこのリポジトリだけの除外に書く（以後 Agent が git add -A しても入らない）
      const excludeFile = join(folder, '.git', 'info', 'exclude')
      const current = await readFile(excludeFile, 'utf8').catch(() => '')
      const lines = excluded.map(excludeLine).filter((line) => !current.split('\n').includes(line))
      if (lines.length > 0) await writeFile(excludeFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Ferret: secrets kept out of the first commit\n${lines.join('\n')}\n`)
      // 先に stage してあった分も外す（ファイルそのものは消さない）
      const unstage = await runGit(git, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...excluded], folder)
      if (unstage.failed) failed(t('repoCreate.errors.gitFailed'))
    }
    if (included.length > 0) {
      const add = await runGit(git, ['add', '-A'], folder)
      if (add.failed) failed(t('repoCreate.errors.gitFailed'))
      const commit = await runGit(git, ['commit', '-q', '--no-verify', '-m', 'Initial commit'], folder)
      if (commit.failed) failed(/user\.(name|email)|identity|tell me who you are/i.test(commit.stderr) ? t('repoCreate.errors.identity') : t('repoCreate.errors.gitFailed'))
      committed = true
    }
  }
  const description = sanitizeDescription(request.description)
  const result = await gh(buildRepoCreateArgs({ owner: request.owner, name: request.name, description }, folder, committed), { cwd: folder, timeoutMs: CREATE_TIMEOUT_MS })
  if (result.failed) createError(result)
  return { url: `https://github.com/${request.owner}/${request.name}`, pushed: committed, excluded: excludedCount }
}
