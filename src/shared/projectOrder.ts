/**
 * サイドバーのプロジェクト一覧の並び順と絞り込み（☆ のみ）。純粋な関数だけを置く。
 *
 * - 並び順: 手動（ドラッグの順 = settings の projects の並び）・動いている順・最近使った順・名前順・追加した順
 * - ☆ を付けたプロジェクトは、どの並び順でも上にまとめる（その中の順は並び順に従う）
 * - 並び順と「☆ のみ」はこの端末だけの好みなので、renderer が localStorage に置く
 */
import type { Project } from './types'

export type ProjectSort = 'manual' | 'active' | 'recent' | 'name' | 'added'
export const PROJECT_SORTS: readonly ProjectSort[] = ['manual', 'active', 'recent', 'name', 'added']

export interface ProjectListView {
  sort: ProjectSort
  /** ☆ を付けたプロジェクトだけを出す */
  starredOnly: boolean
}

export const DEFAULT_PROJECT_VIEW: ProjectListView = { sort: 'manual', starredOnly: false }

/** 保存した値を読む。知らない値・壊れた形は既定に戻す */
export function sanitizeProjectView(raw: unknown): ProjectListView {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROJECT_VIEW }
  const r = raw as Record<string, unknown>
  return {
    sort: PROJECT_SORTS.includes(r.sort as ProjectSort) ? (r.sort as ProjectSort) : 'manual',
    starredOnly: r.starredOnly === true
  }
}

/** Agent の印（renderer/terminal/agentActivity.ts の ProjectActivity と同じ値） */
type Activity = 'blocked' | 'working' | 'done'
/** 動いている順: 確認待ち → 作業中 → 終わった（まだ見ていない）→ それ以外 */
const ACTIVITY_RANK: Record<Activity, number> = { blocked: 0, working: 1, done: 2 }

export interface ProjectSortContext {
  /** プロジェクトごとの Agent の印 */
  activity?: Readonly<Record<string, Activity>>
  /** Agent が最後に動いた時刻（ms）。この端末で見ていたもの */
  agentActiveAt?: Readonly<Record<string, number>>
  locale?: string
}

const time = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/** 最後に使った時刻（開いた・Agent が動いた、の新しいほう）。分からなければ 0 */
export function lastUsedAt(project: Project, ctx: ProjectSortContext = {}): number {
  return Math.max(time(project.lastOpenedAt), ctx.agentActiveAt?.[project.id] ?? 0)
}

/**
 * 表示する並び。☆ を上にまとめ、その中と外をそれぞれ並び順で並べる。
 * 同じ値どうしは手動の順（配列の順）のまま。追加した時刻の無い古いプロジェクトは、時刻のあるものより前（手動の順）
 */
export function sortProjects(projects: readonly Project[], sort: ProjectSort, ctx: ProjectSortContext = {}): Project[] {
  const collator = new Intl.Collator(ctx.locale, { numeric: true, sensitivity: 'base' })
  const compare = (a: Project, b: Project): number => {
    switch (sort) {
      case 'active': {
        const rank = (p: Project) => ACTIVITY_RANK[ctx.activity?.[p.id] as Activity] ?? 3
        return rank(a) - rank(b) || lastUsedAt(b, ctx) - lastUsedAt(a, ctx)
      }
      case 'recent': return lastUsedAt(b, ctx) - lastUsedAt(a, ctx)
      case 'name': return collator.compare(a.name, b.name)
      case 'added': return time(a.addedAt) - time(b.addedAt)
      default: return 0
    }
  }
  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => Number(!!b.project.starred) - Number(!!a.project.starred) || compare(a.project, b.project) || a.index - b.index)
    .map((x) => x.project)
}

/** 絞り込んだあとの一覧（☆ のみ） */
export function filterProjects(sorted: readonly Project[], view: ProjectListView): Project[] {
  return view.starredOnly ? sorted.filter((p) => p.starred) : [...sorted]
}
