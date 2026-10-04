/**
 * Resource Manager（フッター右の「メモリ · >_ 数」とそのポップオーバー）の値の形と整形。
 * main が集計し（src/main/resources.ts）、renderer が表示する。
 *
 * Orca由来: ~/bench/orca/src/shared/process-stats-types.ts の考え方（MIT）。
 * worktree の代わりにプロジェクトで節を切り、内蔵ブラウザのページを節の中に置く。
 */

export interface ResourceTerminal {
  /** main のターミナルID（terminal:create の戻り値） */
  id: string
  pid: number
  title: string
  /** シェルの下で何かが動いている（Agentやコマンド）。緑の点で示す */
  running: boolean
  /** 画面を読み直す前に開かれ、今の画面のどのタブにも付いていない */
  orphan: boolean
  /** そのターミナルのプロセスツリー全体の CPU（1コア=100%） */
  cpu: number
  /** 同じくプロセスツリー全体の RSS（バイト） */
  memory: number
}

interface ResourcePage {
  title: string
  url: string
  cpu: number
  memory: number
}

export interface ResourceProject {
  /** 登録済みプロジェクトに当てはまらないターミナルは null（「その他」） */
  id: string | null
  name: string
  cpu: number
  memory: number
  /** 直近の CPU（古い→新しい）。節のスパークラインに使う */
  cpuHistory: number[]
  terminals: ResourceTerminal[]
  /** 内蔵ブラウザで開いているページ（開いているプロジェクトの節にだけ付く） */
  page: ResourcePage | null
}

export interface ResourceSnapshot {
  /** アプリ本体（Electron の main・画面・GPU など。内蔵ブラウザのページは除く） */
  app: { cpu: number; memory: number }
  projects: ResourceProject[]
  totalCpu: number
  /** Σ RSS（アプリ本体＋内蔵ブラウザ＋全ターミナルのプロセスツリー） */
  totalMemory: number
  terminalCount: number
  orphanCount: number
  collectedAt: number
}

export type ResourceKillTarget = { kind: 'terminal'; id: string } | { kind: 'page' }

// Orca由来: ~/bench/orca/src/renderer/src/components/status-bar/resource-usage-metrics.tsx（MIT）の formatMemory / formatCpu
export function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatCpu(percent: number): string {
  return `${percent.toFixed(1)}%`
}
