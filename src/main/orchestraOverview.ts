import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { EMPTY_PERIODS, addTranscriptLineByPeriod, periodStarts, sumPeriods, transcriptDirName, type CostPeriods, type OrchestraOverview, type ProjectOverview } from '@shared/agentCost'
import { EMPTY_EXTRA_PERIODS, extraPeriods, parseCostFile, type ExtraPeriods } from '@shared/extraCost'
import { parseHumanChecklist, setAnswers, uniqueByUrl, type ChecklistItem } from '@shared/humanChecklist'
import { writeAtomic } from './orchestrator'

/**
 * 全体（すべてのプロダクト）のダッシュボードに出すもの。プロジェクトごとの進み具合・コスト、人の確認リスト（human.md）。
 * コストは Claude Code の会話の記録から今月・今年・総額を数える（@shared/agentCost）と、`.ferret/costs.json` のインフラなどの費用（@shared/extraCost）。
 *
 * 多くのプロダクトを並行して動かしても main を重くしないよう:
 * - 記録はファイルごとに数えた結果を覚え、変わっていないファイルは読まない。書き足されたファイルは前に読んだ所から先だけを読む
 * - 同じフォルダを同時に数えない（数えている途中の結果を待つ）。プロダクトは2つずつ数える
 * - 読む量に上限を付ける（新しい記録から）
 */

const MAX_BYTES_PER_PROJECT = 400 * 1024 * 1024
const MAX_FILE_CACHE = 5000
const CONCURRENCY = 2

interface FileCost {
  size: number
  mtime: number
  /** 読み終えた所（最後の改行の後ろ） */
  offset: number
  /** 数えたときの今月の初め（月が変わったら数え直す） */
  month: number
  periods: CostPeriods
}
const fileCache = new Map<string, FileCost>()
const inflight = new Map<string, Promise<CostPeriods>>()

function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [join(homedir(), '.claude')]
  const inherited = env.CLAUDE_CONFIG_DIR?.trim()
  if (inherited && !dirs.includes(inherited)) dirs.push(inherited)
  return dirs
}

/** ファイルの start から読み、改行で終わった行だけを数える。最後の改行の後ろの位置を返す */
async function countLines(path: string, start: number, periods: CostPeriods, mtime: number, starts: { month: number; year: number }): Promise<{ periods: CostPeriods; offset: number }> {
  let rest = Buffer.alloc(0)
  let offset = start
  let out = periods
  for await (const chunk of createReadStream(path, { start })) {
    let buf = rest.length ? Buffer.concat([rest, chunk as Buffer]) : chunk as Buffer
    let nl = buf.indexOf(10)
    while (nl >= 0) {
      const line = buf.subarray(0, nl).toString('utf8')
      offset += nl + 1
      out = addTranscriptLineByPeriod(out, line, mtime, starts)
      buf = buf.subarray(nl + 1)
      nl = buf.indexOf(10)
    }
    rest = Buffer.from(buf)
  }
  return { periods: out, offset }
}

async function fileCost(path: string, size: number, mtime: number, starts: { month: number; year: number }): Promise<CostPeriods> {
  const cached = fileCache.get(path)
  if (cached && cached.month === starts.month && cached.size === size && cached.mtime === mtime) return cached.periods
  // 書き足しなら続きだけ。縮んだ・月が変わったら初めから
  const resume = cached && cached.month === starts.month && size >= cached.offset && size >= cached.size ? cached : null
  const counted = await countLines(path, resume?.offset ?? 0, resume?.periods ?? EMPTY_PERIODS, mtime, starts)
  if (fileCache.size >= MAX_FILE_CACHE && !fileCache.has(path)) fileCache.delete(fileCache.keys().next().value!)
  fileCache.set(path, { size, mtime, offset: counted.offset, month: starts.month, periods: counted.periods })
  return counted.periods
}

/** そのフォルダで動いた Claude Code の会話の記録から、今月・今年・総額のトークンと概算の金額を数える */
export function projectCost(folder: string, extraConfigDirs: readonly string[] = [], now = Date.now()): Promise<CostPeriods> {
  const key = `${folder}\0${extraConfigDirs.join('\0')}`
  const running = inflight.get(key)
  if (running) return running
  const job = countProject(folder, extraConfigDirs, now).finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

async function countProject(folder: string, extraConfigDirs: readonly string[], now: number): Promise<CostPeriods> {
  const starts = periodStarts(now)
  const names = new Set([transcriptDirName(folder)])
  try { names.add(transcriptDirName(await realpath(folder))) } catch { /* 無いフォルダ（想定内） */ }
  const files: Array<{ path: string; size: number; mtime: number }> = []
  for (const config of [...claudeConfigDirs(), ...extraConfigDirs]) {
    for (const name of names) {
      const dir = join(config, 'projects', name)
      let list: string[]
      try { list = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
      for (const file of list) {
        const path = join(dir, file)
        const info = await stat(path).catch(() => null)
        if (info && !files.some((f) => f.path === path)) files.push({ path, size: info.size, mtime: info.mtimeMs })
      }
    }
  }
  // 新しい記録から読む（上限に届いたら古いものを飛ばす。今月・今年の数を先に正しくする）
  files.sort((a, b) => b.mtime - a.mtime)
  const parts: CostPeriods[] = []
  let budget = MAX_BYTES_PER_PROJECT
  for (const file of files) {
    if (file.size > budget) continue
    budget -= file.size
    parts.push(await fileCost(file.path, file.size, file.mtime, starts).catch(() => EMPTY_PERIODS))
  }
  return sumPeriods(parts)
}

/** そのフォルダの .ferret/costs.json（インフラ・サービスなど）を今月・今年・総額にする。無ければ 0 */
export async function folderExtraCost(folder: string, now = Date.now()): Promise<ExtraPeriods> {
  const text = await readFile(join(folder, '.ferret', 'costs.json'), 'utf8').catch(() => null)
  if (text === null || text.length > 1024 * 1024) return EMPTY_EXTRA_PERIODS
  try {
    return extraPeriods(parseCostFile(JSON.parse(text)), now)
  } catch {
    return EMPTY_EXTRA_PERIODS
  }
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
  listSessions: (folder: string) => Promise<Array<{ id: string; includedCount: number; doneCount: number; humanReviewCount: number }>>
): Promise<OrchestraOverview> {
  const editor = projects.find((p) => p.editorWorkspace)
  const rows = await mapLimit(projects.filter((p) => !p.editorWorkspace && !p.orchestrator && p.source !== 'ssh'), CONCURRENCY, async (p): Promise<ProjectOverview> => {
    const sessions = await listSessions(p.folderPath).catch(() => [])
    const open = sessions.reduce((n, s) => n + Math.max(0, s.includedCount - s.doneCount - s.humanReviewCount), 0)
    const pending = sessions.reduce((n, s) => n + s.humanReviewCount, 0)
    return {
      id: p.id, name: p.name, included: !p.orchestraExcluded, open, pending, reviews: sessions.length,
      lastReview: sessions[0]?.id ?? null,
      cost: await projectCost(p.folderPath).catch(() => EMPTY_PERIODS),
      extra: await folderExtraCost(p.folderPath)
    }
  })
  const checklist = editor ? await readChecklist(editor.folderPath) : { items: [], path: null }
  return {
    projects: rows,
    orchestraCost: editor ? await projectCost(editor.folderPath).catch(() => EMPTY_PERIODS) : EMPTY_PERIODS,
    orchestraExtra: editor ? await folderExtraCost(editor.folderPath) : EMPTY_EXTRA_PERIODS,
    checklist: checklist.items,
    checklistPath: checklist.path
  }
}
