import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { commonBinaryDirs } from '../platform/binaryDirs'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'

/**
 * gh・git を子プロセスで呼ぶ窓口。
 *
 * Finder から起動すると、シェルの PATH（Homebrew など）を引き継がない。gh は内部で git も呼ぶので、
 * よくある場所を PATH に足してから起動する（files.ts の rg と同じ考え方）。
 * 対話の問い合わせ・更新の通知・色は切る。出力はトークンを含みうるので、ログには出さない。
 */

// Windows は gh と Git の既定のインストール先、それ以外は共通の置き場（Linux の linuxbrew・snap を含む）に /bin を足す
const EXTRA_DIRS = process.platform === 'win32'
  ? ['C:\\Program Files\\GitHub CLI', 'C:\\Program Files\\glab', 'C:\\Program Files (x86)\\glab', 'C:\\Program Files\\Git\\cmd']
  : [...commonBinaryDirs(process.platform, homedir()), '/bin']

function searchPath(): string {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_DIRS].filter((d) => d.length > 0)
  return [...new Set(dirs)].join(delimiter)
}

/**
 * gh・git の子プロセスに渡す環境変数。PATH によくある置き場を足し、対話の問い合わせ・更新の通知・色を切る。
 * git clone のように spawn で長く走らせる呼び出し（src/main/projectSources.ts）も、これを使う
 */
export function toolEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env, PATH: searchPath(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    // glab（GitLab CLI）も同じく、問い合わせ・更新の確認・利用状況の送信を切る
    NO_PROMPT: '1', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false'
  }
}

const cliPaths: Record<'gh' | 'glab', string | null | undefined> = { gh: undefined, glab: undefined }
function findCli(cli: 'gh' | 'glab'): string | null {
  if (cliPaths[cli]) return cliPaths[cli]!
  const name = process.platform === 'win32' ? `${cli}.exe` : cli
  cliPaths[cli] = searchPath().split(delimiter).map((dir) => join(dir, name)).find((candidate) => existsSync(candidate)) ?? null
  return cliPaths[cli]!
}

/** gh の絶対パス。見つからなければ null */
export function findGh(): string | null {
  return findCli('gh')
}

/** glab（GitLab CLI）の絶対パス。見つからなければ null */
export function findGlab(): string | null {
  return findCli('glab')
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** 0 以外で終わったか（gh auth status は未ログインで 1 を返すが、出力は使える） */
  failed: boolean
  /** コマンドが無い（ENOENT） */
  missing: boolean
  timedOut: boolean
}

export function run(file: string, args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: toolEnv()
    }, (err, stdout, stderr) => {
      const error = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        failed: Boolean(error),
        missing: error?.code === 'ENOENT',
        timedOut: Boolean(error?.killed)
      })
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/** gh を呼ぶ。gh が無ければ missing: true */
export async function gh(args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return runCli('gh', args, options)
}

/** glab を呼ぶ。glab が無ければ missing: true。入力（題名・本文など）は引数の配列か標準入力で渡し、シェルを通さない */
export async function glab(args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return runCli('glab', args, options)
}

async function runCli(cli: 'gh' | 'glab', args: string[], options: { cwd?: string; input?: string; timeoutMs?: number }): Promise<ExecResult> {
  const file = findCli(cli)
  if (!file) return { stdout: '', stderr: '', failed: true, missing: true, timedOut: false }
  const result = await run(file, args, options)
  // 入れ直し・アンインストールで場所が変わったら、次は探し直す
  if (result.missing) cliPaths[cli] = undefined
  return result
}

export type GhErrorKind = 'missing' | 'timeout' | 'not-logged-in' | 'rate-limited' | 'repo-not-found' | 'network' | 'failed'

/**
 * gh の失敗。利用者に見せる想定内のもので、**クラッシュレポート（Sentry）には送らない**（UserFacingError）。
 * gh の出力はリポジトリ名・パス・URL・メール・トークンを含みうるので、送ってよい情報として扱わない。
 * 種類（kind）は決まった値だけ。出力の1行目は画面に出す文にだけ入れる（端末の外へは出さない）
 */
export class GhCommandError extends UserFacingError {
  constructor(message: string, readonly kind: GhErrorKind) {
    super(message)
  }
}

/** 画面に出す前に伏せるもの：gh・GitHub・GitLab のトークン、Bearer の値、URL の認証情報 */
export function redactGhOutput(text: string): string {
  return text
    .replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/\b(glpat-|gloas-|gldt-|glrt-|glptt-|glft-|glsoat-|glcbt-)[A-Za-z0-9_.-]+/g, '$1***')
    .replace(/(PRIVATE-TOKEN:?\s*)\S+/gi, '$1***')
    .replace(/\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@')
}

/** gh の失敗を、決まった種類と画面に出せる短い文にする */
export function classifyGhError(result: ExecResult): { kind: GhErrorKind; message: string } {
  if (result.missing) return { kind: 'missing', message: t('github.errors.ghMissing') }
  if (result.timedOut) return { kind: 'timeout', message: t('github.errors.timeout') }
  const text = redactGhOutput(`${result.stderr}\n${result.stdout}`)
  if (/gh auth login|not logged in|authentication/i.test(text)) return { kind: 'not-logged-in', message: t('github.errors.notLoggedIn') }
  if (/rate limit/i.test(text)) return { kind: 'rate-limited', message: t('github.errors.rateLimited') }
  if (/could not resolve to a repository|not found/i.test(text)) return { kind: 'repo-not-found', message: t('github.errors.repoNotFound') }
  if (/network|dial tcp|timeout|could not connect/i.test(text)) return { kind: 'network', message: t('github.errors.network') }
  const first = text.split('\n').map((l) => l.trim()).find(Boolean)
  return { kind: 'failed', message: first ? t('github.errors.failedWith', { detail: first.slice(0, 200) }) : t('github.errors.failed') }
}

/** gh のエラー出力を、画面に出せる短い文にする。トークンらしき文字列は伏せる */
export function ghErrorMessage(result: ExecResult): string {
  return classifyGhError(result).message
}

/** gh の失敗を投げる形にする（UserFacingError なので Sentry には送られない） */
export function ghError(result: ExecResult): GhCommandError {
  const { kind, message } = classifyGhError(result)
  return new GhCommandError(message, kind)
}
