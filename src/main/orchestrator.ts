import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SUBAGENT_PREFIX,
  orchestratorChildren,
  planSubagents,
  renderSubagent,
  type ChildEntry,
  type OrchestratorChild
} from '@shared/orchestrator'

/**
 * オーケストレーターの subagent を <親>/.claude/agents/ に書く・消す（@shared/orchestrator）。
 * 書くのは ferret-*.md で Ferret の印があるもの（か、まだ無いもの）だけ。ほかのファイルには触れない。
 * - .claude・.claude/agents・ファイルがリンクなら書かない（別の場所を書き換えさせない）
 * - 一時ファイルに書いてから置き換える
 */

export interface OrchestratorSync {
  children: OrchestratorChild[]
  written: string[]
  removed: string[]
  /** 同じ名前で利用者のファイルがあるので書かなかったもの */
  skipped: string[]
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

/** 親のすぐ下のフォルダ（リンクは辿らない） */
async function childEntries(folder: string): Promise<ChildEntry[]> {
  const dirents = await readdir(folder, { withFileTypes: true })
  return Promise.all(dirents.filter((d) => d.isDirectory()).map(async (d) => ({ name: d.name, isGitRepo: await exists(join(folder, d.name, '.git')) })))
}

/** 子のプロジェクトを調べるだけ（書かない） */
export async function findOrchestratorChildren(folder: string, registered: ReadonlyArray<{ folderPath: string; name: string }>): Promise<OrchestratorChild[]> {
  return orchestratorChildren(folder, await childEntries(folder), registered, join)
}

async function agentsDir(folder: string): Promise<string> {
  const claude = join(folder, '.claude')
  const dir = join(claude, 'agents')
  if (await isLink(claude) || await isLink(dir)) throw new Error(`refusing to write subagents through a symbolic link: ${dir}`)
  return dir
}

async function existingSubagents(dir: string): Promise<Array<{ file: string; text: string | null }>> {
  let names: string[]
  try { names = await readdir(dir) } catch { return [] } // まだ無い（想定内）
  return Promise.all(names.filter((n) => n.startsWith(SUBAGENT_PREFIX) && n.endsWith('.md')).map(async (file) => {
    const path = join(dir, file)
    if (await isLink(path)) return { file, text: null }
    try { return { file, text: await readFile(path, 'utf8') } } catch { return { file, text: null } }
  }))
}

/**
 * 子ごとの subagent を今のフォルダの中身に合わせる。enabled が false なら Ferret の subagent を全部消す
 */
export async function syncOrchestrator(folder: string, registered: ReadonlyArray<{ folderPath: string; name: string }>, enabled = true): Promise<OrchestratorSync> {
  const children = enabled ? await findOrchestratorChildren(folder, registered) : []
  const dir = await agentsDir(folder)
  const want = children.map((c) => ({ file: `${c.agent}.md`, text: renderSubagent(c, folder, join) }))
  const plan = planSubagents(await existingSubagents(dir), want)
  if (plan.write.length) await mkdir(dir, { recursive: true, mode: 0o755 })
  for (const w of plan.write) await writeAtomic(dir, w.file, w.text)
  for (const file of plan.remove) await rm(join(dir, file), { force: true })
  return { children, written: plan.write.map((w) => w.file), removed: plan.remove, skipped: plan.skipped }
}

async function writeAtomic(dir: string, file: string, text: string): Promise<void> {
  const path = join(dir, file)
  if (await isLink(dir) || await isLink(path)) throw new Error(`refusing to write a subagent through a symbolic link: ${path}`)
  const tmp = join(dir, `.${file}.${process.pid}.${Date.now().toString(36)}.tmp`)
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
