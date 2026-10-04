import { useSyncExternalStore } from 'react'

/**
 * どのプロジェクトで Agent が動いているか・確認を待っているか・終わったか（サイドバーの印に使う）。
 *
 * 状態の検知は TerminalPane が 1 秒ごとに terminal:agentState で行っている（main/terminal.ts の detectState）。
 * その結果をプロジェクトごとにまとめてここへ置き、サイドバーが読む。App を経由しないので、
 * ターミナルとサイドバーのどちらの props も増やさない。
 */

/** ペイン1枚の状態。projectId は未登録のフォルダなら null */
interface PaneActivity {
  projectId: string | null
  state: string
}

/** 動いている（working の）ペインを持つプロジェクト。並びを固定し、同じ中身なら同じ文字列になるようにする */
export function workingProjectIds(panes: readonly PaneActivity[]): string[] {
  const ids = new Set<string>()
  for (const pane of panes) if (pane.projectId && pane.state === 'working') ids.add(pane.projectId)
  return [...ids].sort()
}

/** 閉じる前に確かめるべきか: Agent が作業中（working）か確認待ち（blocked）のペインがある（Orca #14817 #24426） */
export function hasBusyAgent(states: ReadonlyArray<string | undefined>): boolean {
  return states.some((state) => state === 'working' || state === 'blocked')
}

/** プロジェクトの印。確認待ち・作業中・終わった（まだ見ていない）の順に、気づいてほしいものを出す */
export type ProjectActivity = 'blocked' | 'working' | 'done'

const ACTIVITY_PRIORITY: ProjectActivity[] = ['blocked', 'working', 'done']

/** プロジェクトごとの印。未登録のフォルダと、待機中・不明だけのプロジェクトは入れない */
export function projectActivity(panes: readonly PaneActivity[]): Record<string, ProjectActivity> {
  const result: Record<string, ProjectActivity> = {}
  for (const pane of panes) {
    if (!pane.projectId) continue
    const rank = ACTIVITY_PRIORITY.indexOf(pane.state as ProjectActivity)
    if (rank < 0) continue
    const current = result[pane.projectId]
    if (current === undefined || rank < ACTIVITY_PRIORITY.indexOf(current)) result[pane.projectId] = ACTIVITY_PRIORITY[rank]!
  }
  return result
}

let activity: Record<string, ProjectActivity> = {}
let activityKey = ''
const listeners = new Set<() => void>()

/** TerminalPane が状態を読み直すたびに呼ぶ。中身が変わったときだけ知らせる */
export function publishAgentActivity(panes: readonly PaneActivity[]): void {
  const next = projectActivity(panes)
  const key = JSON.stringify(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
  if (key === activityKey) return
  activity = next
  activityKey = key
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** プロジェクトごとの Agent の印（サイドバー） */
export function useProjectActivity(): Readonly<Record<string, ProjectActivity>> {
  return useSyncExternalStore(subscribe, () => activity)
}
