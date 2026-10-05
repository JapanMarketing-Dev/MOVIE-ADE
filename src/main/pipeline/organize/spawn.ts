/** 子プロセスの共通実行（stdin でプロンプトを渡し、stdout を集める） */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { RunnerError } from './runner'
import { resolveSpawn } from '../../platform/windowsSpawn'
import { resolveTrustedExecutable } from '../../agentExecutable'

export interface SpawnTextOptions {
  binary: string
  args: string[]
  cwd: string
  timeoutMs: number;
  /** stdin へ流す文字列 */
  stdin?: string
  env?: NodeJS.ProcessEnv
  /** 開いているプロジェクトのフォルダ。この中のフォルダ・実体の CLI は使わない（security-6 [6]） */
  project?: string
}

/**
 * 整理の CLI（claude / codex）を、組み込みの Agent と同じ決まりで信頼できる絶対パスにする（security-6 [6]。agentExecutable.ts）。
 * 素の名前を受け継いだ PATH で探させると、PATH にプロジェクトのフォルダ（や `.`・相対の項目）があれば、
 * プロジェクトに置かれた同じ名前のものが、アカウントの環境変数を渡されて動く。
 * 絶対パスで、プロジェクトの外を指す PATH の項目（main の PATH とログインシェルの PATH）だけから探す。見つからなければ起動しない
 */
export async function resolveOrganizerCli(binary: string, opt: { project?: string; env?: NodeJS.ProcessEnv; dirs?: readonly string[]; home?: string; platform?: NodeJS.Platform } = {}): Promise<string | null> {
  const home = opt.home ?? homedir()
  const platform = opt.platform ?? process.platform
  const dirs = opt.dirs ?? (platform === 'win32' ? undefined : await (await import('../../agentDetection')).searchDirs())
  const found = await resolveTrustedExecutable(binary, { env: opt.env ?? process.env, cwd: opt.project ?? home, home, platform, ...(dirs ? { dirs } : {}) })
  return found.ok ? found.path : null
}

export interface SpawnTextDeps {
  /** テスト用。省略時は resolveOrganizerCli */
  resolve?: (binary: string, opt: { project?: string; env?: NodeJS.ProcessEnv }) => Promise<string | null>
}

export interface SpawnTextResult {
  stdout: string
  stderr: string
  code: number | null
  elapsedMs: number
  commandLine: string
}

export async function spawnText(opt: SpawnTextOptions, deps: SpawnTextDeps = {}): Promise<SpawnTextResult> {
  const commandLine = [opt.binary, ...opt.args].join(' ')
  // 起動する実体は、信頼できる絶対パスに決めてから渡す（素の名前を spawn に探させない。security-6 [6]）
  const trusted = await (deps.resolve ?? resolveOrganizerCli)(opt.binary, { ...(opt.project ? { project: opt.project } : {}), ...(opt.env ? { env: opt.env } : {}) })
  if (!trusted) throw new RunnerError(`LLM を起動できませんでした: ${opt.binary} が、プロジェクトの外の PATH に見つかりません`, 'spawn', commandLine)
  const started = Date.now()

  return new Promise<SpawnTextResult>((resolve, reject) => {
    // Windows の codex.cmd などは、そのままでは起動できない（windowsSpawn.ts）
    let resolved
    try {
      resolved = resolveSpawn(trusted, opt.args, opt.env ?? process.env)
    } catch (e) {
      reject(new RunnerError(`LLM を起動できませんでした: ${(e as Error).message}`, 'spawn', commandLine))
      return
    }
    const child = spawn(resolved.file, resolved.args, {
      cwd: opt.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: resolved.env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      reject(
        new RunnerError(
          `LLM の実行がタイムアウトしました (${opt.timeoutMs}ms)`,
          'timeout',
          commandLine,
          stderr.slice(-2000),
        ),
      )
    }, opt.timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new RunnerError(`LLM を起動できませんでした: ${e.message}`, 'spawn', commandLine))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, elapsedMs: Date.now() - started, commandLine })
    })

    if (opt.stdin !== undefined) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(opt.stdin)
    } else {
      child.stdin.end()
    }
  })
}

/**
 * テキストから JSON 部分を取り出す。
 * スキーマ指定があれば素のJSONが返るが、コードフェンスや前置きが付く場合に備える。
 */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw new RunnerError('LLM の出力が空でした', 'empty')

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const body = fence?.[1]?.trim() ?? trimmed

  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new RunnerError(`LLM の出力にJSONが見つかりません: ${body.slice(0, 300)}`, 'empty')
  }
  return body.slice(start, end + 1)
}
