import { useCallback, useEffect, useRef, useState } from 'react'
import { CLI_TOOLS, cliInstallCommand, cliLoginCommand, type CliToolId, type CliToolStatus } from '@shared/cliTools'
import type { PlatformName } from '@shared/types'
import { requestTerminalCommand } from './terminalCommand'

/**
 * 設定の「CLI」の一覧・判定モデルの欄などで、CLI のインストール・ログインを内蔵ターミナルで走らせる部分。
 * 走らせるのはカタログ（@shared/cliTools）の固定のコマンドだけ。画面の入力を混ぜない。
 */

export type CliAction = 'install' | 'login'

/** 今の OS（preload の platform。無ければ darwin 扱い） */
export function currentPlatform(): PlatformName {
  return (globalThis as { window?: { ade?: { platform?: PlatformName } } }).window?.ade?.platform ?? 'darwin'
}

/** そのボタンで走らせるコマンド。その OS で出せなければ undefined */
export function cliActionCommand(id: CliToolId, action: CliAction, platform: PlatformName = currentPlatform()): string | undefined {
  return action === 'install' ? cliInstallCommand(id, platform) : cliLoginCommand(id)
}

export type CliRunResult = 'terminal' | 'copied' | 'failed'

/**
 * 内蔵ターミナルの新しいタブでコマンドを走らせる。ターミナルが受け取れなければ（開いていない）コマンドを写す。
 * request・copy は単体テストで差し替える
 */
export async function runCliAction(
  id: CliToolId,
  action: CliAction,
  title: string,
  deps: { request?: typeof requestTerminalCommand; copy?: (text: string) => Promise<void>; platform?: PlatformName } = {}
): Promise<{ result: CliRunResult; command: string | undefined }> {
  const command = cliActionCommand(id, action, deps.platform)
  if (!command) return { result: 'failed', command }
  const request = deps.request ?? requestTerminalCommand
  if (request({ command, title })) return { result: 'terminal', command }
  try {
    await (deps.copy ?? ((text: string) => navigator.clipboard.writeText(text)))(command)
    return { result: 'copied', command }
  } catch {
    return { result: 'failed', command }
  }
}

/** インストールを始めたあと、見つかるまで検出し直す間隔と上限（インストールは数分かかることがある） */
const WATCH_INTERVAL_MS = 4000
const WATCH_LIMIT_MS = 5 * 60_000

/**
 * CLI の検出結果。watch(id) でインストールを始めたものを、見つかるまで（上限まで）定期的に検出し直す
 */
export function useCliTools(): {
  tools: CliToolStatus[] | null
  refresh: () => Promise<CliToolStatus[] | null>
  watch: (id: CliToolId) => void
  watching: ReadonlySet<CliToolId>
} {
  const [tools, setTools] = useState<CliToolStatus[] | null>(null)
  const [watching, setWatching] = useState<ReadonlySet<CliToolId>>(new Set())
  const timer = useRef<number | undefined>(undefined)
  const deadline = useRef(0)
  const watchingRef = useRef(watching)
  watchingRef.current = watching

  const refresh = useCallback(async () => {
    try {
      const next = await window.ade.invoke('cliTools:list', true)
      setTools(next)
      return next
    } catch {
      // 失敗は main の IPC が Sentry へ送る（一覧は前のまま）
      return null
    }
  }, [])

  useEffect(() => {
    void window.ade.invoke('cliTools:list').then(setTools).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    return () => window.clearTimeout(timer.current)
  }, [])

  const tick = useCallback(async () => {
    const next = await refresh()
    const installed = new Set(next?.filter((tool) => tool.installed).map((tool) => tool.id) ?? [])
    const rest = new Set([...watchingRef.current].filter((id) => !installed.has(id)))
    const expired = Date.now() > deadline.current
    setWatching(expired ? new Set() : rest)
    if (rest.size > 0 && !expired) timer.current = window.setTimeout(() => void tick(), WATCH_INTERVAL_MS)
  }, [refresh])

  const watch = useCallback((id: CliToolId) => {
    deadline.current = Date.now() + WATCH_LIMIT_MS
    setWatching((prev) => new Set(prev).add(id))
    watchingRef.current = new Set(watchingRef.current).add(id)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void tick(), WATCH_INTERVAL_MS)
  }, [tick])

  return { tools, refresh, watch, watching }
}

export function cliLabel(id: CliToolId): string {
  return CLI_TOOLS[id].label
}
