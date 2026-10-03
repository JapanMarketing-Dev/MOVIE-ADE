import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'

/**
 * プロセスの今のカレントを pid から調べる（分割したペインに、シェルの今のカレントを引き継ぐため）。
 *
 * Orca由来: ~/bench/orca/src/main/providers/process-cwd.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Linux は /proc/<pid>/cwd、macOS は `lsof -a -p <pid> -d cwd -Fn`。どちらも使えなければ ''（Windows など）。
 * ⌘D を続けて押しても lsof を重ねて起動しないよう、同じ pid への問い合わせはまとめ、短い間だけ覚えておく。
 */

const CACHE_TTL_MS = 1500
const LSOF_TIMEOUT_MS = 1500

const resultCache = new Map<number, { value: string; at: number }>()
const inflight = new Map<number, Promise<string>>()

export async function resolveProcessCwd(pid: number): Promise<string> {
  const now = Date.now()
  for (const [cachedPid, entry] of resultCache) {
    if (now - entry.at >= CACHE_TTL_MS) resultCache.delete(cachedPid)
  }
  const cached = resultCache.get(pid)
  if (cached) return cached.value
  const existing = inflight.get(pid)
  if (existing) return existing
  const promise = doResolve(pid).then((value) => {
    resultCache.set(pid, { value, at: Date.now() })
    inflight.delete(pid)
    return value
  })
  inflight.set(pid, promise)
  return promise
}

async function doResolve(pid: number): Promise<string> {
  if (process.platform === 'win32') return ''
  try {
    return await readlink(`/proc/${pid}/cwd`)
  } catch {
    /* macOS には /proc が無いので lsof へ */
  }
  try {
    // -a で -p と -d を AND にする。無いと macOS の lsof は OR で全プロセスの cwd を返してしまう（Orca の注記）
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS }, (error, out) =>
        error ? reject(error) : resolve(out)
      )
    })
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.includes('/')) return line.slice(1)
    }
  } catch {
    /* 調べられなければ空 */
  }
  return ''
}
