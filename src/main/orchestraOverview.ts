import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import type { OrchestraOverview, ProjectOverview } from '@shared/orchestraOverview'
import { EMPTY_EXTRA_PERIODS, EMPTY_FORECAST, costForecast, extraPeriods, parseCosts, type CostForecast, type ExtraPeriods } from '@shared/extraCost'
import { parseHumanChecklist, setAnswers, uniqueByUrl, type ChecklistItem } from '@shared/humanChecklist'
import { writeAtomic } from './orchestrator'
import { orchestraMembers } from '@shared/orchestras'
import { DEFAULT_SECTIONS, MAX_NOTE_BYTES, parseDashboard, type DashboardLayout } from '@shared/dashboardLayout'

/**
 * 全体（すべてのプロダクト）のダッシュボードに出すもの。プロジェクトごとの進み具合・インフラのコスト、人の確認リスト（human.md）。
 * コストは各フォルダの `.ferret/costs.json` の実績（今月・今年・総額）と今のリソースからの推定の月額（@shared/extraCost）。
 * AI（Agent の会話・サブスクリプション）は数えない。プロダクトは2つずつ読む
 */

const CONCURRENCY = 2
const NO_COSTS = { periods: EMPTY_EXTRA_PERIODS, forecast: EMPTY_FORECAST }

/** そのフォルダの .ferret/costs.json を実績（今月・今年・総額）と推定の月額にする。無ければ 0 */
export async function folderCosts(folder: string, now = Date.now()): Promise<{ periods: ExtraPeriods; forecast: CostForecast }> {
  const text = await readFile(join(folder, '.ferret', 'costs.json'), 'utf8').catch(() => null)
  if (text === null || text.length > 1024 * 1024) return NO_COSTS
  try {
    const file = parseCosts(JSON.parse(text))
    return { periods: extraPeriods(file.items, now), forecast: costForecast(file, now) }
  } catch {
    return NO_COSTS
  }
}

/** 中身を読む（大きすぎる・無い・ファイルでないものは null） */
async function readSmall(path: string, max: number): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > max) return null
  return readFile(path, 'utf8').catch(() => null)
}

/**
 * オーケストラのフォルダの .ferret/dashboard.json（@shared/dashboardLayout）。無ければ今までの並び、壊れていれば今までの並びに invalid。
 * note の中身は、そのフォルダからの相対パスのファイルを読む（parseDashboard が外へ出るパスを断ってある）
 */
export async function readDashboard(folder: string | null): Promise<DashboardLayout> {
  const fallback: DashboardLayout = { sections: DEFAULT_SECTIONS, notes: {}, custom: false }
  if (!folder) return fallback
  const text = await readSmall(join(folder, '.ferret', 'dashboard.json'), 256 * 1024)
  if (text === null) return fallback
  let sections: ReturnType<typeof parseDashboard> = null
  try { sections = parseDashboard(JSON.parse(text)) } catch { /* 壊れた JSON（想定内。画面で知らせる） */ }
  if (!sections) return { ...fallback, custom: true, invalid: true }
  const notes: Record<string, string | null> = {}
  for (const s of sections) if (s.type === 'note' && !(s.file in notes)) notes[s.file] = await readSmall(join(folder, s.file), MAX_NOTE_BYTES)
  return { sections, notes, custom: true }
}

/** 並べたものを n 個ずつ処理する（順番は保つ） */
async function mapLimit<T, R>(list: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++
      out[i] = await fn(list[i]!)
    }
  }))
  return out
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

/** 人の答えを全体のフォルダの human.md の「## 回答」に書く。human.md が無ければ作らない（答える項目が無い） */
export async function writeAnswers(editorFolder: string, entries: ReadonlyArray<{ key: string; answer: string }>, lang: 'ja' | 'en'): Promise<ChecklistItem[]> {
  for (const name of ['human.md', 'HUMAN.md']) {
    const text = await readFile(join(editorFolder, name), 'utf8').catch(() => null)
    if (text === null) continue
    if (text.length > 4 * 1024 * 1024) throw new Error('human.md is too large')
    const next = setAnswers(text, entries, lang)
    // リンクの先には書かない（writeAtomic が確かめる）
    if (next !== text) await writeAtomic(editorFolder, name, next)
    return uniqueByUrl(parseHumanChecklist(next))
  }
  return []
}

export async function orchestraOverview(
  projects: readonly Project[],
  orchestra: Project | null,
  listSessions: (folder: string) => Promise<Array<{ id: string; includedCount: number; doneCount: number; humanReviewCount: number }>>
): Promise<OrchestraOverview> {
  const editor = orchestra
  // そのオーケストラに属するプロダクト（外したものも表に出す）
  const rows = await mapLimit(editor ? orchestraMembers(projects, editor.id, { includeExcluded: true }) : [], CONCURRENCY, async (p): Promise<ProjectOverview> => {
    const sessions = await listSessions(p.folderPath).catch(() => [])
    const open = sessions.reduce((n, s) => n + Math.max(0, s.includedCount - s.doneCount - s.humanReviewCount), 0)
    const pending = sessions.reduce((n, s) => n + s.humanReviewCount, 0)
    const costs = await folderCosts(p.folderPath)
    return {
      id: p.id, name: p.name, included: !p.orchestraExcluded, open, pending, reviews: sessions.length,
      lastReview: sessions[0]?.id ?? null,
      extra: costs.periods,
      forecast: costs.forecast
    }
  })
  const checklist = editor ? await readChecklist(editor.folderPath) : { items: [], path: null }
  const shared = editor ? await folderCosts(editor.folderPath) : NO_COSTS
  return {
    projects: rows,
    orchestraExtra: shared.periods,
    orchestraForecast: shared.forecast,
    checklist: checklist.items,
    checklistPath: checklist.path,
    dashboard: await readDashboard(editor?.folderPath ?? null)
  }
}
