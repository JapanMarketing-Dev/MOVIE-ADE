import { spawn } from 'node:child_process'
import { devNull } from 'node:os'
import { delimiter } from 'node:path'
import type { GitActionResult, GitRepoStatus } from '@shared/github'
import {
  autoFetchAllowedByEnv, classifyGitError, emptyFetchState, gitActionAvailability, parseGitStatus, pushPrecondition, recordFetch, shouldFetch,
  type FetchTrigger, type GitFetchState, type GitSyncAction, type GitSyncErrorKind
} from '@shared/gitSync'
import { resolveTrustedExecutable, windowsSearchPathEnv } from '../agentExecutable'
import { searchDirs } from '../agentDetection'
import { redactGhOutput, toolEnv } from './gh'
import { resolveRemote } from './index'

/**
 * フッターの git：状態の読み取り・裏の fetch・最新の取得（fast-forward だけ）・push。
 *
 * - git は信頼できる絶対パスで起動する（agentExecutable.ts の resolveTrustedExecutable。プロジェクトの中・相対の PATH の項目は使わない。
 *   Windows で .cmd / .bat しか見つからないときは起動しない）
 * - 引数は決まった配列だけ。リモート名・ブランチ名・URL など、利用者やリモートが決める文字列を引数に入れない
 *   （fetch は今のブランチの upstream のリモート、取り込みは @{upstream}、push は push.default=upstream で決める）
 * - 問い合わせは出さない：端末の問い合わせ・askpass・資格情報マネージャーの画面を切り、POSIX では端末から切り離して起動する。
 *   時間切れはプロセスのグループごと止める
 * - 裏の fetch はフック・fsmonitor を動かさない。利用者が押した取り込み・push は、利用者のフック（husky など）をそのまま動かす
 * - 同じフォルダの git の操作は1つずつ（index.lock を取り合わない）
 */

const STATUS_TIMEOUT_MS = 5_000
const FETCH_TIMEOUT_MS = 60_000
const MERGE_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 90_000
const GIT_CACHE_MS = 5 * 60_000

interface GitRun {
  stdout: string
  stderr: string
  failed: boolean
  missing: boolean
  timedOut: boolean
}

// ─── git の実体 ─────────────────────────────

const gitPaths = new Map<string, { path: string | null; at: number }>()

/** そのプロジェクトで使う git の絶対パス。プロジェクトの中のもの・相対の PATH の項目からは選ばない。無ければ null */
export async function trustedGit(folder: string): Promise<string | null> {
  const cached = gitPaths.get(folder)
  if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.path
  const env = toolEnv()
  // POSIX は main の PATH・ログインシェルの PATH・よくある置き場（toolEnv の PATH）から。Windows は env の PATH の絶対パスの項目から
  const dirs = process.platform === 'win32' ? undefined : [...new Set([...(await searchDirs()), ...(env.PATH ?? '').split(delimiter)])]
  const resolved = await resolveTrustedExecutable('git', { env, cwd: folder, dirs })
  // .cmd / .bat は cmd.exe を通すことになるので使わない（Git for Windows は cmd\git.exe）
  const path = resolved.ok && !/\.(cmd|bat)$/i.test(resolved.path) ? resolved.path : null
  gitPaths.set(folder, { path, at: Date.now() })
  return path
}

/** 子プロセスの環境。問い合わせを出さない・出力を英語にする */
export function gitSyncEnv(base: NodeJS.ProcessEnv = toolEnv(), platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...windowsSearchPathEnv(platform),
    GIT_TERMINAL_PROMPT: '0',
    // 空にすると core.askPass・SSH_ASKPASS へ回らず、問い合わせを出さずに失敗する
    GIT_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    // Git Credential Manager のログイン画面を出さない
    GCM_INTERACTIVE: 'never',
    GIT_MERGE_AUTOEDIT: 'no',
    // 失敗の種類を英語の出力から決める
    LC_ALL: 'C',
    LANGUAGE: 'C'
  }
  delete env.SSH_ASKPASS
  return env
}

/** どの呼び出しにも付ける設定 */
const BASE_CONFIG = ['-c', 'credential.interactive=never', '-c', 'core.quotePath=false']
/** 裏の fetch だけに付ける：フックと fsmonitor を動かさない */
const QUIET_CONFIG = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false']

function runGit(git: string, folder: string, args: readonly string[], timeoutMs: number): Promise<GitRun> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result: GitRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const posix = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(git, ['-C', folder, ...BASE_CONFIG, ...args], {
        // POSIX は新しいセッションにして端末から切り離す（ssh がパスフレーズを端末で聞かない）。止めるときはグループごと
        detached: posix,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: gitSyncEnv()
      })
    } catch {
      // 起動できない（実体が消えた）
      resolve({ stdout: '', stderr: '', failed: true, missing: true, timedOut: false })
      return
    }
    const cap = (prev: string, chunk: Buffer): string => (prev.length > 1024 * 1024 ? prev : prev + chunk.toString('utf8'))
    child.stdout?.on('data', (chunk: Buffer) => { stdout = cap(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = cap(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill()
      } catch {
        // もう終わっている（想定内）
      }
    }, timeoutMs)
    child.on('error', (error: NodeJS.ErrnoException) => finish({ stdout, stderr, failed: true, missing: error.code === 'ENOENT', timedOut }))
    child.on('close', (code) => finish({ stdout, stderr, failed: code !== 0 || timedOut, missing: false, timedOut }))
  })
}

// ─── 状態 ─────────────────────────────

const fetchStates = new Map<string, GitFetchState>()
const busy = new Map<string, GitSyncAction>()
const queues = new Map<string, Promise<unknown>>()

function fetchState(folder: string): GitFetchState {
  return fetchStates.get(folder) ?? emptyFetchState()
}

/** 同じフォルダの操作を1つずつ走らせる */
function exclusive<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(folder) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  const tail = next.catch(() => undefined)
  queues.set(folder, tail)
  void tail.then(() => { if (queues.get(folder) === tail) queues.delete(folder) })
  return next
}

function emptyStatus(): GitRepoStatus {
  return {
    isGit: false, repo: null, branch: null, shortOid: null, headOid: null, changes: 0, ahead: 0, behind: 0,
    hasUpstream: false, upstream: null, upstreamGone: false, hasRemote: false,
    fetch: { fetching: false, lastFetchAt: null, lastError: null }, busy: null
  }
}

/**
 * フッターの状態。git を2回だけ呼ぶ（remote get-url と status --porcelain=v2 --branch）。status は optional locks を切って
 * 走らせるので、ターミナルで動いている git と index.lock を取り合わない。
 * 追跡外のファイルは `normal`（ディレクトリ単位）で数え、node_modules などの大きなフォルダを歩き回らない。
 */
export async function readGitStatus(folder: string | null): Promise<GitRepoStatus> {
  if (!folder) return emptyStatus()
  const git = await trustedGit(folder)
  if (!git) return emptyStatus()
  const [status, remote] = await Promise.all([
    runGit(git, folder, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], STATUS_TIMEOUT_MS),
    runGit(git, folder, ['remote', 'get-url', 'origin'], STATUS_TIMEOUT_MS)
  ])
  if (status.failed) return emptyStatus()
  const summary = parseGitStatus(status.stdout)
  const state = fetchState(folder)
  return {
    isGit: true,
    repo: remote.failed ? null : await resolveRemote(remote.stdout),
    ...summary,
    hasRemote: summary.hasUpstream || !remote.failed,
    fetch: { fetching: state.fetching, lastFetchAt: state.lastFetchAt, lastError: state.lastError },
    busy: busy.get(folder) ?? null
  }
}

/** git の失敗を結果にする。failed のときだけ、出力の1行目（伏せたもの）を添える */
function failure(run: GitRun): { error: GitSyncErrorKind; detail: string | null } {
  const error = classifyGitError(run.stderr, run)
  if (error !== 'failed') return { error, detail: null }
  const first = redactGhOutput(run.stderr).split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !/^hint:/i.test(l))
  return { error, detail: first ? first.slice(0, 200) : null }
}

/** fetch を1回（状態の記録を含む）。今のブランチの upstream のリモート（無ければ origin）を、引数を足さずに git に選ばせる */
async function doFetch(folder: string, git: string): Promise<GitRun> {
  fetchStates.set(folder, { ...fetchState(folder), fetching: true })
  const run = await runGit(git, folder, [...QUIET_CONFIG, 'fetch', '--quiet', '--no-recurse-submodules'], FETCH_TIMEOUT_MS)
  fetchStates.set(folder, recordFetch(fetchState(folder), Date.now(), run.failed ? failure(run).error : null))
  return run
}

/**
 * 裏の fetch。走らせるかは shouldFetch が決める（開いたときはすぐ・定期と前に出したときは5分おき・失敗が続けば延ばす）。
 * 走らせなかったら null。失敗は状態に残すだけで投げない（フッターの吹き出しに静かに出す）
 */
export async function autoFetch(folder: string | null, trigger: FetchTrigger, visible: boolean): Promise<GitRepoStatus | null> {
  if (!folder) return null
  // E2E はネットワークへ出ない（ローカルの bare リポジトリで確かめる E2E だけ ADE_E2E_GIT_FETCH=1 で走らせる）
  if (trigger !== 'manual' && !autoFetchAllowedByEnv(process.env)) return null
  if (busy.has(folder) || !shouldFetch(trigger, fetchState(folder), Date.now(), visible)) return null
  // 調べている間に同じきっかけ（フッターが2か所にあるときなど）でもう一度呼ばれても重ねない
  const previous = fetchState(folder)
  fetchStates.set(folder, { ...previous, fetching: true })
  let started = false
  try {
    const git = await trustedGit(folder)
    if (!git) return null
    const before = await readGitStatus(folder)
    if (!before.isGit || !before.hasRemote) return null
    started = true
    return await exclusive(folder, async () => {
      await doFetch(folder, git)
      return readGitStatus(folder)
    })
  } finally {
    // 走らせなかったときは、印だけ戻す（試した時刻は付けない）
    if (!started) fetchStates.set(folder, { ...fetchState(folder), fetching: false })
  }
}

/**
 * 利用者が押した操作。
 * - fetch: リモートの変更を確かめる
 * - pull: fetch してから、分かれていなければ @{upstream} へ fast-forward（マージ・rebase はしない）
 * - push: 確認を出したときの HEAD（expectedHead）のままで、取り込んでいないものが無いときだけ、upstream へ push
 */
export async function runGitAction(folder: string | null, action: GitSyncAction, expectedHead: string | null): Promise<GitActionResult> {
  const result = (status: GitRepoStatus, error: GitSyncErrorKind | null, detail: string | null = null, commits = 0): GitActionResult =>
    ({ ok: error === null, action, error, detail, commits, status })
  if (!folder) return result(emptyStatus(), 'notGit')
  const git = await trustedGit(folder)
  if (!git) return result(emptyStatus(), 'gitMissing')
  if (busy.has(folder)) return result(await readGitStatus(folder), 'locked')
  busy.set(folder, action)
  try {
    const done = await exclusive(folder, async () => {
      if (action === 'push') {
        const status = await readGitStatus(folder)
        const blocked = pushPrecondition(status, expectedHead ?? '')
        if (blocked) return result(status, blocked)
        if (status.ahead === 0) return result(status, null)
        const push = await runGit(git, folder, ['-c', 'push.default=upstream', 'push'], PUSH_TIMEOUT_MS)
        if (push.failed) {
          const { error, detail } = failure(push)
          return result(await readGitStatus(folder), error, detail)
        }
        return result(await readGitStatus(folder), null, null, status.ahead)
      }
      const fetched = await doFetch(folder, git)
      if (fetched.failed) {
        const { error, detail } = failure(fetched)
        return result(await readGitStatus(folder), error, detail)
      }
      const status = await readGitStatus(folder)
      if (action === 'fetch') return result(status, null)
      const available = gitActionAvailability(status).pull
      if (!available.enabled) return result(status, available.reason)
      if (status.behind === 0) return result(status, null)
      const merge = await runGit(git, folder, ['merge', '--ff-only', '--no-edit', '@{upstream}'], MERGE_TIMEOUT_MS)
      if (merge.failed) {
        const { error, detail } = failure(merge)
        return result(await readGitStatus(folder), error, detail)
      }
      return result(await readGitStatus(folder), null, null, status.behind)
    })
    // 返す状態は、この操作が終わった後のもの。中で読んだ状態には自分の busy が入っているので外す
    // （残すと、フッターのボタンが次の読み直し（30 秒ごと）まで押せないままになる）
    return { ...done, status: { ...done.status, busy: null } }
  } finally {
    busy.delete(folder)
  }
}
