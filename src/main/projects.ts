import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import type { Project, Settings } from '@shared/types'

/**
 * 登録済みプロジェクト（フォルダ＋URLプリセット）の純粋な操作。
 * 保存（settings）と画面への通知（index.ts）からは切り離し、単体テストで確かめられるようにする。
 * Orca の Projects に当たるが、worktree・SSH・リモートホストの概念は持ち込まない。
 */

/** 同じフォルダかを比べる鍵。末尾の区切りと相対表記の揺れをならす */
export function folderKey(folderPath: string): string {
  const resolved = resolve(folderPath)
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved
}

export function findProjectByFolder(projects: Project[], folderPath: string): Project | undefined {
  const key = folderKey(folderPath)
  return projects.find((p) => folderKey(p.folderPath) === key)
}

export function newProject(folderPath: string, id: string = randomUUID()): Project {
  const folder = resolve(folderPath)
  return { id, name: basename(folder) || folder, folderPath: folder, urls: [] }
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
