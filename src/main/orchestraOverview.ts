import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Project } from '@shared/types'
import { EMPTY_TOTALS, addTranscriptLine, transcriptDirName, type OrchestraOverview, type ProjectOverview, type TokenTotals } from '@shared/agentCost'
import { parseHumanChecklist, uniqueByUrl, type ChecklistItem } from '@shared/humanChecklist'

/**
 * 全体（すべてのプロダクト）のダッシュボードに出すもの。プロジェクトごとの進み具合・コスト、人の確認リスト（human.md）。
 * コストは Claude Code の会話の記録から直近 30 日分を数える（@shared/agentCost。読む量に上限を付け、5 分は使い回す）
 */

const COST_DAYS = 30
const MAX_BYTES_PER_PROJECT = 200 * 1024 * 1024
const CACHE_MS = 5 * 60 * 1000
const costCache = new Map<string, { at: number; totals: TokenTotals }>()

function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [join(homedir(), '.claude')]
  const inherited = env.CLAUDE_CONFIG_DIR?.trim()
  if (inherited && !dirs.includes(inherited)) dirs.push(inherited)
  return dirs
}

/** そのフォルダで動いた Claude Code の直近の会話の記録から、トークンと概算の金額を数える */
export async function projectCost(folder: string, extraConfigDirs: readonly string[] = [], now = Date.now()): Promise<TokenTotals> {
  const cached = costCache.get(folder)
  if (cached && now - cached.at < CACHE_MS) return cached.totals
  const since = now - COST_DAYS * 24 * 60 * 60 * 1000
  const names = new Set([transcriptDirName(folder)])
  try { names.add(transcriptDirName(await realpath(folder))) } catch { /* 無いフォルダ（想定内） */ }
  let totals = EMPTY_TOTALS
  let budget = MAX_BYTES_PER_PROJECT
  for (const config of [...claudeConfigDirs(), ...extraConfigDirs]) {
    for (const name of names) {
      const dir = join(config, 'projects', name)
      let files: string[]
      try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
      for (const file of files) {
        const path = join(dir, file)
        const info = await stat(path).catch(() => null)
        if (!info || info.mtimeMs < since || info.size > budget) continue
        budget -= info.size
        const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
        for await (const line of lines) totals = addTranscriptLine(totals, line)
      }
    }
  }
  costCache.set(folder, { at: now, totals })
  return totals
}

/** 全体のフォルダの human.md（HUMAN.md も見る）を読み、URL の付いた行を確認リストにする */
export async function readChecklist(editorFolder: string): Promise<{ items: ChecklistItem[]; path: string | null }> {
  for (const name of ['human.md', 'HUMAN.md']) {
    const path = join(editorFolder, name)
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text !== null) return { items: uniqueByUrl(parseHumanChecklist(text)), path }
  }
  return { items: [], path: null }
}

export async function orchestraOverview(
  projects: readonly Project[],
  listSessions: (folder: string) => Promise<Array<{ id: string; includedCount: number; doneCount: number; humanReviewCount: number }>>
): Promise<OrchestraOverview> {
  const editor = projects.find((p) => p.editorWorkspace)
  const rows = await Promise.all(projects.filter((p) => !p.editorWorkspace && !p.orchestrator && p.source !== 'ssh').map(async (p): Promise<ProjectOverview> => {
    const sessions = await listSessions(p.folderPath).catch(() => [])
    const open = sessions.reduce((n, s) => n + Math.max(0, s.includedCount - s.doneCount - s.humanReviewCount), 0)
    const pending = sessions.reduce((n, s) => n + s.humanReviewCount, 0)
    return {
      id: p.id, name: p.name, included: !p.orchestraExcluded, open, pending, reviews: sessions.length,
      lastReview: sessions[0]?.id ?? null,
      cost: await projectCost(p.folderPath).catch(() => EMPTY_TOTALS)
    }
  }))
  const checklist = editor ? await readChecklist(editor.folderPath) : { items: [], path: null }
  return {
    projects: rows,
    orchestraCost: editor ? await projectCost(editor.folderPath).catch(() => EMPTY_TOTALS) : EMPTY_TOTALS,
    checklist: checklist.items,
    checklistPath: checklist.path,
    costDays: COST_DAYS
  }
}
