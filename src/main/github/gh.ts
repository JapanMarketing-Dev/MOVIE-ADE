import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { commonBinaryDirs } from '../platform/binaryDirs'
import { t } from '@shared/i18n'

/**
 * gh・git を子プロセスで呼ぶ窓口。
 *
 * Finder から起動すると、シェルの PATH（Homebrew など）を引き継がない。gh は内部で git も呼ぶので、
 * よくある場所を PATH に足してから起動する（files.ts の rg と同じ考え方）。
 * 対話の問い合わせ・更新の通知・色は切る。出力はトークンを含みうるので、ログには出さない。
 */

// Windows は gh と Git の既定のインストール先、それ以外は共通の置き場（Linux の linuxbrew・snap を含む）に /bin を足す
const EXTRA_DIRS = process.platform === 'win32'
  ? ['C:\\Program Files\\GitHub CLI', 'C:\\Program Files\\Git\\cmd']
  : [...commonBinaryDirs(process.platform, homedir()), '/bin']

function searchPath(): string {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_DIRS].filter((d) => d.length > 0)
  return [...new Set(dirs)].join(delimiter)
}

let ghPath: string | null | undefined
/** gh の絶対パス。見つからなければ null */
export function findGh(): string | null {
  if (ghPath) return ghPath
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh'
  ghPath = searchPath().split(delimiter).map((dir) => join(dir, name)).find((candidate) => existsSync(candidate)) ?? null
  return ghPath
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
      env: { ...process.env, PATH: searchPath(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
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
  const file = findGh()
  if (!file) return { stdout: '', stderr: '', failed: true, missing: true, timedOut: false }
  const result = await run(file, args, options)
  // 入れ直し・アンインストールで場所が変わったら、次は探し直す
  if (result.missing) ghPath = undefined
  return result
}

/** gh のエラー出力を、画面に出せる短い日本語にする。トークンらしき文字列は伏せる */
export function ghErrorMessage(result: ExecResult): string {
  if (result.missing) return t('github.errors.ghMissing')
  if (result.timedOut) return t('github.errors.timeout')
  const text = `${result.stderr}\n${result.stdout}`.replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
  if (/gh auth login|not logged in|authentication/i.test(text)) return t('github.errors.notLoggedIn')
  if (/rate limit/i.test(text)) return t('github.errors.rateLimited')
  if (/could not resolve to a repository|not found/i.test(text)) return t('github.errors.repoNotFound')
  if (/network|dial tcp|timeout|could not connect/i.test(text)) return t('github.errors.network')
  const first = text.split('\n').map((l) => l.trim()).find(Boolean)
  return first ? t('github.errors.failedWith', { detail: first.slice(0, 200) }) : t('github.errors.failed')
}
