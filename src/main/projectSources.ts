import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  cloneFailure,
  cloneRepoName,
  mapGitHubRepos,
  normalizeCloneUrl,
  parseCloneProgress,
  parseSshConfigHosts,
  stripUrlCredentials,
  type CloneFailureKind,
  type CloneProgress,
  type GitHubRepoList,
  type SshConfigHost
} from '@shared/projectSource'
import { classifyGhError, gh, redactGhOutput, toolEnv, type ExecResult } from './github/gh'

/**
 * プロジェクトを「GitHub から取得」「SSH で開く」ときの main 側の処理。
 * 判定や文の組み立ては src/shared/projectSource.ts / sshCommand.ts の純粋な関数で、ここは外とのやり取りだけ。
 *
 * Orca由来（MIT）: ~/bench/orca/src/main/ipc/repos/repo-clone-lifecycle.ts の
 *   「clone は1つだけ、進み具合を送り、キャンセルしたら自分で作ったフォルダを消す」流れ。
 * clone は対話なし（GIT_TERMINAL_PROMPT=0、ssh -o BatchMode=yes）で動かす。見えない所でパスワードを待って止まらないように。
 */

/** ~/.ssh/config の Host（読めなければ空）。home はテストで差し替える */
export function listSshHosts(home: string = homedir()): SshConfigHost[] {
  try {
    return parseSshConfigHosts(readFileSync(join(home, '.ssh', 'config'), 'utf8'))
  } catch {
    return []
  }
}

type GhRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>

/** 自分のリポジトリの一覧（gh にログイン済みのときだけ）。gh の呼び出しは github-integration の部品を使う */
export async function listGitHubRepos(run: GhRunner = gh): Promise<GitHubRepoList> {
  const result = await run(['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,url,sshUrl,isPrivate,updatedAt'], { timeoutMs: 30_000 })
  if (result.missing) return { ghInstalled: false, loggedIn: false, repos: [] }
  if (result.failed || result.timedOut) {
    const { kind, message } = classifyGhError(result)
    return { ghInstalled: true, loggedIn: kind !== 'not-logged-in', repos: [], ...(kind === 'not-logged-in' ? {} : { error: message }) }
  }
  try {
    return { ghInstalled: true, loggedIn: true, repos: mapGitHubRepos(JSON.parse(result.stdout)) }
  } catch {
    return { ghInstalled: true, loggedIn: true, repos: [] }
  }
}

/** clone の保存先の親フォルダの既定（前回の場所は renderer が覚える） */
export function defaultCloneParent(home: string = homedir()): string {
  for (const name of ['Projects', 'src', 'Developer', 'code']) {
    if (existsSync(join(home, name))) return join(home, name)
  }
  return join(home, 'Projects')
}

type CloneOutcome = { ok: true; path: string; url: string } | { ok: false; kind: CloneFailureKind; detail: string }

let active: { child: ChildProcess; cancelled: boolean } | null = null

/** 動いている clone を止める（作りかけのフォルダは cloneRepository が消す） */
export function cancelClone(): void {
  if (!active) return
  active.cancelled = true
  active.child.kill()
}

/**
 * clone の ssh を、確認を出さない（BatchMode）ようにする環境変数。利用者が選んでいる ssh
 * （GIT_SSH_COMMAND・GIT_SSH・git config の core.sshCommand。鍵やアカウントの切り替えに使う）は置き換えず、
 * 後ろに -o BatchMode=yes を足すだけにする。置き換えると、その鍵が使われず Permission denied になる（Orca #21985）
 */
export function cloneSshEnv(env: Record<string, string | undefined>, configuredSshCommand: string | null): Record<string, string> {
  const fromEnv = env.GIT_SSH_COMMAND?.trim()
  if (fromEnv) return { GIT_SSH_COMMAND: `${fromEnv} -o BatchMode=yes` }
  // GIT_SSH は実行ファイルのパスだけで、引数を足せない。そのまま使わせる
  if (env.GIT_SSH?.trim()) return {}
  const configured = configuredSshCommand?.trim()
  return { GIT_SSH_COMMAND: `${configured || 'ssh'} -o BatchMode=yes` }
}

/** git config の core.sshCommand（無ければ null） */
async function configuredSshCommand(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['config', '--get', 'core.sshCommand'], { cwd, env, timeout: 3000 })
    return stdout.trim() || null
  } catch {
    // 未設定（終了コード 1）や git が無い（clone も失敗して理由を出す）
    return null
  }
}

/**
 * git clone --progress <url> <parent>/<名前>。終わったら clone したフォルダの絶対パスを返す。
 * 既にあるフォルダには clone しない（中身を上書きしない）。キャンセル・失敗のときは自分で作ったフォルダだけを消す。
 */
export async function cloneRepository(
  input: { url: string; parent: string },
  onProgress: (progress: CloneProgress) => void,
  spawnGit: typeof spawn = spawn
): Promise<CloneOutcome> {
  const checked = normalizeCloneUrl(input.url)
  if (!checked.ok) return { ok: false, kind: 'failed', detail: 'invalid url' }
  const name = cloneRepoName(checked.url)
  if (!name || !isAbsolute(input.parent)) return { ok: false, kind: 'failed', detail: 'invalid destination' }
  if (active) return { ok: false, kind: 'failed', detail: 'another clone is running' }
  const dest = join(input.parent, name)
  if (existsSync(dest) && readdirSync(dest).length > 0) return { ok: false, kind: 'exists', detail: dest }
  await mkdir(input.parent, { recursive: true })
  const created = !existsSync(dest)
  const env = toolEnv()
  const sshEnv = cloneSshEnv(env, await configuredSshCommand(input.parent, env))

  return new Promise<CloneOutcome>((resolve) => {
    let stderr = ''
    const child = spawnGit('git', ['clone', '--progress', '--', checked.url, dest], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0', ...sshEnv, GCM_INTERACTIVE: 'never' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const job = { child, cancelled: false }
    active = job
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // 長い出力でも、失敗の理由に要る末尾だけを残す
      stderr = (stderr + chunk).slice(-16_000)
      const progress = parseCloneProgress(chunk)
      if (progress) onProgress(progress)
    })
    const finish = async (outcome: CloneOutcome) => {
      if (active === job) active = null
      if (!outcome.ok && created) await rm(dest, { recursive: true, force: true }).catch(() => undefined)
      resolve(outcome)
    }
    child.on('error', (err) => void finish({ ok: false, kind: 'failed', detail: redactGhOutput(stripUrlCredentials(String(err.message))) }))
    child.on('close', (code) => {
      if (job.cancelled) return void finish({ ok: false, kind: 'cancelled', detail: '' })
      if (code === 0) return void finish({ ok: true, path: dest, url: stripUrlCredentials(checked.url) })
      const failure = cloneFailure(stderr)
      void finish({ ok: false, kind: failure.kind, detail: redactGhOutput(failure.detail) })
    })
  })
}
