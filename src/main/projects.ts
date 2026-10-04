import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import type { Project, Settings } from '@shared/types'
import { applySubsetOrder } from '@shared/reorder'

/**
 * 登録済みプロジェクト（フォルダ＋URLプリセット）の純粋な操作。
 * 保存（settings）と画面への通知（index.ts）からは切り離し、単体テストで確かめられるようにする。
 * Orca の Projects に当たるが、worktree・SSH・リモートホストの概念は持ち込まない。
 */

/** 同じフォルダかを比べる鍵。末尾の区切りと相対表記の揺れをならす */
function folderKey(folderPath: string): string {
  const resolved = resolve(folderPath)
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved
}

export function findProjectByFolder(projects: Project[], folderPath: string): Project | undefined {
  const key = folderKey(folderPath)
  return projects.find((p) => folderKey(p.folderPath) === key)
}

export function newProject(folderPath: string, id: string = randomUUID(), now: Date = new Date()): Project {
  const folder = resolve(folderPath)
  return { id, name: basename(folder) || folder, folderPath: folder, urls: [], addedAt: now.toISOString() }
}

/** 開いた時刻を残す（「最近使った順」「動いている順」）。知らない ID なら一覧はそのまま */
export function markProjectOpened(projects: Project[], id: string, now: Date = new Date()): Project[] {
  return projects.some((p) => p.id === id) ? projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: now.toISOString() } : p)) : projects
}

/**
 * フォルダを登録する。既に同じフォルダがあればそれを返し、一覧は変えない。
 * Orca由来: ~/bench/orca/src/renderer/src/components/sidebar/add-repo-store-upsert.ts の
 * 「同一なら既存を使う（alreadyPresent）」の考え方（MIT）。
 */
export function upsertProjectFolder(
  projects: Project[],
  folderPath: string,
  id?: string
): { projects: Project[]; project: Project; alreadyPresent: boolean } {
  const existing = findProjectByFolder(projects, folderPath)
  if (existing) return { projects, project: existing, alreadyPresent: true }
  const project = newProject(folderPath, id)
  return { projects: [...projects, project], project, alreadyPresent: false }
}

/**
 * 旧設定（folderPath だけを覚えていた版）からの移行。
 * プロジェクトが1つも無く、前回のフォルダが残っていれば、それを最初のプロジェクトにする。
 * 登録を全部外した後は folderPath も消すので、ここで勝手に復活することはない。
 */
export function migrateLegacySettings(settings: Settings, id?: string): Settings {
  if (settings.projects.length > 0 || !settings.folderPath) return settings
  const project = newProject(settings.folderPath, id)
  return { ...settings, projects: [project], activeProjectId: project.id }
}

/**
 * 一覧の並べ替え（サイドバーのドラッグ＆ドロップ・Alt+↑↓・メニューの「上へ」「下へ」）。
 * ids は renderer から来た新しい並び。知らない ID・重複は捨て、ids に無いプロジェクトはその位置のまま。
 * 並びは settings の projects の配列の順そのもの（古い設定もそのまま読める）
 */
export function reorderProjects(projects: Project[], ids: unknown): Project[] {
  if (!Array.isArray(ids)) return projects
  const byId = new Map(projects.map((p) => [p.id, p]))
  const subset = ids.flatMap((id) => (typeof id === 'string' && byId.has(id) ? [byId.get(id)!] : []))
  return applySubsetOrder(projects, subset)
}
