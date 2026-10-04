import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { quoteStartupArg, type AgentStartupShell } from '@shared/agentLaunch'
import { findWindowsExecutable, type WindowsFs } from './platform/windowsSpawn'

/**
 * 組み込みの Agent・アカウントのログインの実行ファイルを、信頼できる絶対パスにする（security-4 [1]・security-5 [5]）。
 *
 * 素の名前（claude / codex）をプロジェクトで動くシェルに探させると、プロジェクトに置かれた同じ名前のものを拾うことがある。
 *   - Windows の cmd.exe は、PATH より先に「今のフォルダ」（＝プロジェクト）を探す
 *   - macOS / Linux でも、PATH に `.`・空の項目・相対の項目・プロジェクトの中のフォルダがあれば、
 *     またはシェルの起動ファイル（direnv など）がプロジェクトのフォルダを PATH に足せば、そこから拾う
 * そこで main が起動の前に、main の PATH とログインシェルの PATH（どちらもプロジェクトの外で取ったもの）の、
 * 絶対パスでプロジェクトの外を指す項目だけから実体を探し、見つかった絶対パスで起動する。
 * 実体の本当の場所（リンクの先）がプロジェクトの中なら使わない。見つからなければ起動しない。
 * 絶対パスで渡すので、シェルの起動ファイルが PATH や関数・alias を変えても、どれが動くかは変わらない。
 * SSH のプロジェクトでは、リモートのシェルで同じ決まりで探してから exec する1行を渡す（remoteTrustedLaunchLine）。
 */

type TrustedExecutable = { ok: true; path: string } | { ok: false; reason: 'not-found' | 'relative' | 'inside-project' }

export interface PosixFs {
  /** 本当の場所（リンクをたどったもの）。無ければ null */
  realpath: (path: string) => Promise<string | null>
  /** 普通のファイルで、実行できるか */
  isExecutableFile: (path: string) => Promise<boolean>
}

const nodePosixFs: PosixFs = {
  realpath: (path) => realpath(path).catch(() => null), // 無いフォルダ・ファイル（PATH の候補を順に調べている。想定内）
  isExecutableFile: async (path) => {
    try {
      if (!(await stat(path)).isFile()) return false
      await access(path, constants.X_OK)
      return true
    } catch {
      // 無い・実行できない候補（想定内）
      return false
    }
  }
}

interface TrustedExecutableOptions {
  platform?: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** タブの今のフォルダ（プロジェクト）。この中のフォルダ・実体は使わない */
  cwd: string
  /** POSIX で探すフォルダ（main の PATH とログインシェルの PATH。agentDetection.ts の searchDirs）。無ければ env.PATH */
  dirs?: readonly string[]
  /** ホームのフォルダ。cwd がホームかその上なら、プロジェクトとして除くものは無い（~/.local/bin などを外さない） */
  home?: string
  fs?: WindowsFs
  posixFs?: PosixFs
}

function isInsideWith(path: typeof posix | typeof win32, dir: string, base: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** PATH から、プロジェクトの中を指す項目を外す（Windows の環境変数名は大文字小文字を区別しない） */
function envWithoutProjectPath(env: NodeJS.ProcessEnv, project: string | null): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  if (!key) return env
  const entries = (env[key] ?? '').split(';').filter((entry) => {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    return dir.length > 0 && win32.isAbsolute(dir) && (project === null || !isInsideWith(win32, dir, project))
  })
  return { ...env, [key]: entries.join(';') }
}

function resolveWindows(head: string, options: TrustedExecutableOptions): TrustedExecutable {
  // ドライブ相対（C:x）や .\x のような相対の指定は、今のフォルダ次第で別のものになる
  if (!win32.isAbsolute(head) && /[\\/:]/.test(head)) return { ok: false, reason: 'relative' }
  const home = options.home ?? homedir()
  // ホーム（プロジェクトを開いていない・ログイン）で動かすときは、ホームの下の PATH（npm・公式のインストーラ）を外さない
  const project = isInsideWith(win32, home, options.cwd) ? null : options.cwd
  if (win32.isAbsolute(head) && project !== null && isInsideWith(win32, head, project)) return { ok: false, reason: 'inside-project' }
  const found = win32.isAbsolute(head)
    ? findWindowsExecutable(head, options.env, options.fs)
    : findWindowsExecutable(head, envWithoutProjectPath(options.env, project), options.fs)
  return found ? { ok: true, path: found } : { ok: false, reason: 'not-found' }
}

async function resolvePosix(head: string, options: TrustedExecutableOptions): Promise<TrustedExecutable> {
  const fs = options.posixFs ?? nodePosixFs
  const home = options.home ?? homedir()
  const cwd = (await fs.realpath(options.cwd)) ?? posix.resolve(options.cwd)
  const realHome = (await fs.realpath(home)) ?? home
  const project = isInsideWith(posix, realHome, cwd) ? null : cwd
  const outside = (path: string): boolean => project === null || !isInsideWith(posix, path, project)
  const expanded = head === '~' ? home : head.startsWith('~/') ? posix.join(home, head.slice(2)) : head
  const candidates: string[] = []
  if (expanded.includes('/')) {
    // 設定に書いた絶対パス。bin/claude のような相対は、今のフォルダ次第で別のものになる
    if (!posix.isAbsolute(expanded)) return { ok: false, reason: 'relative' }
    candidates.push(posix.normalize(expanded))
  } else {
    for (const dir of options.dirs ?? (options.env.PATH ?? '').split(':')) {
      // 空・`.`・相対の項目は、今のフォルダ（プロジェクト）を指す
      if (!dir || !posix.isAbsolute(dir)) continue
      const real = await fs.realpath(dir)
      if (real && outside(real)) candidates.push(posix.join(real, head))
    }
  }
  let inside = false
  for (const candidate of new Set(candidates)) {
    const real = await fs.realpath(candidate)
    if (!real) continue
    if (!outside(real)) {
      inside = true
      continue
    }
    // 起動はリンクの名前のまま（公式のインストーラの Claude Code は versions/<版> へのリンク。前面プロセスの判定に使う）
    if (await fs.isExecutableFile(real)) return { ok: true, path: candidate }
  }
  return { ok: false, reason: inside && expanded.includes('/') ? 'inside-project' : 'not-found' }
}

export async function resolveTrustedExecutable(head: string, options: TrustedExecutableOptions): Promise<TrustedExecutable> {
  if (!head) return { ok: false, reason: 'not-found' }
  const platform = options.platform ?? process.platform
  return platform === 'win32' ? resolveWindows(head, options) : resolvePosix(head, options)
}

/** 絶対パスを、そのシェルでコマンドとして実行できる書き方にする */
function invokePath(path: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') return `& ${quoteStartupArg(path, 'powershell')}`
  return quoteStartupArg(path, shell)
}

/** 確かめた絶対パスと、決まりを通した引数から、シェルへ流し込む1行を作る */
export function trustedLaunchLine(path: string, args: readonly string[], shell: AgentStartupShell): string {
  return [invokePath(path, shell), ...args.map((arg) => quoteStartupArg(arg, shell))].join(' ')
}

/**
 * リモート（SSH）で、プロジェクトの外の絶対パスの PATH の項目だけから実行ファイルを探して exec する /bin/sh のスクリプト。
 * $1 が名前、残りが引数。PATH の項目とファイルの本当の場所（pwd -P・readlink -f）が今のフォルダの中なら使わない。
 * 名前に / を含むもの（相対・プロジェクトの中のパス）は受け付けない。1行で、単一引用符を含まない
 */
const REMOTE_RESOLVE_SCRIPT = [
  'n=$1; shift',
  'case $n in ""|*/*) echo "ferret: $n: not found" >&2; exit 127;; esac',
  'p=$(pwd -P) || exit 127',
  'h=$(cd ~ 2>/dev/null && pwd -P)',
  'case $h/ in "$p"/*) p=;; esac',
  'set -f; IFS=:',
  'for d in $PATH; do case $d in /*) ;; *) continue;; esac; r=$(cd "$d" 2>/dev/null && pwd -P) || continue; ' +
    'if [ -n "$p" ]; then case $r/ in "$p"/*) continue;; esac; fi; f=$r/$n; [ -f "$f" ] && [ -x "$f" ] || continue; ' +
    'x=$(readlink -f "$f" 2>/dev/null) || x=$f; if [ -n "$p" ]; then case $x/ in "$p"/*) continue;; esac; fi; unset IFS; set +f; exec "$f" "$@"; done',
  'echo "ferret: $n: not found" >&2; exit 127'
].join('; ')

/** SSH のプロジェクトで、組み込みの Agent を信頼できる場所から起動する1行（リモートのシェルは POSIX か fish） */
export function remoteTrustedLaunchLine(argv: readonly string[]): string {
  const [head, ...args] = argv
  return ['/bin/sh', '-c', REMOTE_RESOLVE_SCRIPT, 'ferret', head ?? '', ...args].map((arg) => quoteStartupArg(arg, 'posix')).join(' ')
}

/**
 * Windows の PTY に渡す環境変数。NoDefaultCurrentDirectoryInExePath があると、cmd.exe は素の名前を
 * 今のフォルダから探さない（NeedCurrentDirectoryForExePathW）。利用者が手で打つコマンドも含めて、
 * プロジェクトに置かれた同じ名前の .cmd / .exe を拾わない
 */
export function windowsSearchPathEnv(platform: NodeJS.Platform = process.platform): Record<string, string> {
  return platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}
}
