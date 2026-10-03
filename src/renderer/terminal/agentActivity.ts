import { useSyncExternalStore } from 'react'

/**
 * どのプロジェクトで Agent が動いているか（サイドバーの「実行中」の印に使う）。
 *
 * 状態の検知は TerminalPane が 1 秒ごとに terminal:agentState で行っている（main/terminal.ts の detectState）。
 * その結果をプロジェクトごとにまとめてここへ置き、サイドバーが読む。App を経由しないので、
 * ターミナルとサイドバーのどちらの props も増やさない。
 */

/** ペイン1枚の状態。projectId は未登録のフォルダなら null */
export interface PaneActivity {
  projectId: string | null
  state: string
}

/** 動いている（working の）ペインを持つプロジェクト。並びを固定し、同じ中身なら同じ文字列になるようにする */
export function workingProjectIds(panes: readonly PaneActivity[]): string[] {
  const ids = new Set<string>()
  for (const pane of panes) if (pane.projectId && pane.state === 'working') ids.add(pane.projectId)
  return [...ids].sort()
}

let working: readonly string[] = []
const listeners = new Set<() => void>()

/** TerminalPane が状態を読み直すたびに呼ぶ。中身が変わったときだけ知らせる */
export function publishAgentActivity(panes: readonly PaneActivity[]): void {
  const next = workingProjectIds(panes)
  if (next.length === working.length && next.every((id, i) => id === working[i])) return
  working = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Agent が動いているプロジェクトの ID */
export function useWorkingProjects(): readonly string[] {
  return useSyncExternalStore(subscribe, () => working)
}
