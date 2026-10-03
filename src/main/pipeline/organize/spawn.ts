/** 子プロセスの共通実行（stdin でプロンプトを渡し、stdout を集める） */
import { spawn } from 'node:child_process'
import { RunnerError } from './runner'
import { resolveSpawn } from '../../platform/windowsSpawn'

export interface SpawnTextOptions {
  binary: string
  args: string[]
  cwd: string
  timeoutMs: number;
  /** stdin へ流す文字列 */
  stdin?: string
  env?: NodeJS.ProcessEnv
}

export interface SpawnTextResult {
  stdout: string
  stderr: string
  code: number | null
  elapsedMs: number
  commandLine: string
}

export async function spawnText(opt: SpawnTextOptions): Promise<SpawnTextResult> {
  const commandLine = [opt.binary, ...opt.args].join(' ')
  const started = Date.now()

  return new Promise<SpawnTextResult>((resolve, reject) => {
    // Windows の codex.cmd などは、そのままでは起動できない（windowsSpawn.ts）
    let resolved
    try {
      resolved = resolveSpawn(opt.binary, opt.args, opt.env ?? process.env)
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
