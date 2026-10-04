import { win32 } from 'node:path'
import { quoteStartupArg, type AgentStartupShell } from '@shared/agentLaunch'
import { findWindowsExecutable, type WindowsFs } from './platform/windowsSpawn'

/**
 * 組み込みの Agent・アカウントのログインの起動コマンドを、信頼できる絶対パスにする（security-4 [1]）。
 *
 * Windows の cmd.exe は、素の名前（claude / codex）を PATH より先に「今のフォルダ」から探す。
 * ターミナルの今のフォルダは開いたプロジェクトなので、プロジェクトに claude.cmd を置かれると、
 * プロジェクトを開いただけ（自動起動）で、または利用者のアカウントの環境のまま（ログイン）でそれが動いてしまう。
 * そこで main が起動の前に、絶対パスの PATH の項目だけから実体を探し、見つかった絶対パスで起動する。
 * プロジェクトの中を指す PATH の項目は使わない。見つからなければ起動しない（今のフォルダから探させない）。
 * macOS / Linux のシェルは今のフォルダを探さないので、そのまま返す。
 */

type TrustedCommand = { ok: true; command: string } | { ok: false; reason: 'not-found' | 'relative' }

interface TrustedCommandOptions {
  platform?: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** タブの今のフォルダ（プロジェクト）。この中の PATH の項目は使わない */
  cwd: string
  shell: AgentStartupShell
  fs?: WindowsFs
}

/** 先頭の語（コマンド本体）と残り（引数）に分ける。`"C:\Program Files\x.exe" --a` の形も読む */
export function splitLeadingCommand(command: string): { head: string; rest: string } {
  const trimmed = command.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    if (end > 0) return { head: trimmed.slice(1, end), rest: trimmed.slice(end + 1) }
  }
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed)
  return match ? { head: match[1]!, rest: match[2]! } : { head: '', rest: '' }
}

function isInside(dir: string, base: string): boolean {
  const rel = win32.relative(win32.resolve(base), win32.resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel))
}

/** PATH から、プロジェクトの中を指す項目を外す（Windows の環境変数名は大文字小文字を区別しない） */
function envWithoutProjectPath(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  if (!key) return env
  const entries = (env[key] ?? '').split(';').filter((entry) => {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    return dir.length > 0 && win32.isAbsolute(dir) && !isInside(dir, cwd)
  })
  return { ...env, [key]: entries.join(';') }
}

/** 絶対パスを、そのシェルでコマンドとして実行できる書き方にする */
function invokePath(path: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') return `& ${quoteStartupArg(path, 'powershell')}`
  return quoteStartupArg(path, shell)
}

export function resolveTrustedCommand(command: string, options: TrustedCommandOptions): TrustedCommand {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { ok: true, command }
  const { head, rest } = splitLeadingCommand(command)
  if (!head) return { ok: false, reason: 'not-found' }
  // ドライブ相対（C:x）や .\x のような相対の指定は、今のフォルダ次第で別のものになる
  if (!win32.isAbsolute(head) && /[\\/:]/.test(head)) return { ok: false, reason: 'relative' }
  const found = win32.isAbsolute(head)
    ? findWindowsExecutable(head, options.env, options.fs)
    : findWindowsExecutable(head, envWithoutProjectPath(options.env, options.cwd), options.fs)
  if (!found) return { ok: false, reason: 'not-found' }
  return { ok: true, command: `${invokePath(found, options.shell)}${rest}` }
}

/**
 * Windows の PTY に渡す環境変数。NoDefaultCurrentDirectoryInExePath があると、cmd.exe は素の名前を
 * 今のフォルダから探さない（NeedCurrentDirectoryForExePathW）。利用者が手で打つコマンドも含めて、
 * プロジェクトに置かれた同じ名前の .cmd / .exe を拾わない
 */
export function windowsSearchPathEnv(platform: NodeJS.Platform = process.platform): Record<string, string> {
  return platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}
}
