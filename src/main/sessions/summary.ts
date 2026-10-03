/**
 * 一覧用の要約（summary.json）。
 *
 * サイドバーの一覧は、開くたびに全レビューを読む。そのたびに session.json（文字起こし込み）と
 * events.jsonl（90分なら数千行）を読むと重いので、一覧に要る分だけを summary.json に控える。
 * 書くのは session.json を保存したとき（分解の完了・編集のたび。store.ts の saveSession）。
 * summary.json が無い古いレビューは、一覧を読むときに1度だけ作る（history.ts）。
 *
 * 名前・アーカイブ・送った時刻は label.json にあり、一覧のたびに読む（小さいので控えない）。
 * 進み具合（progress.json）も Agent が書き換えるので控えず、一覧のたびに読んで includedIds と突き合わせる。
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { SessionPaths } from './paths'
import type { SessionRecord } from './store'
import { getLocale, type SupportedLocale } from '@shared/i18n'
import { AUTO_NAME_MAX, buildAutoName, cleanReviewTitle } from './autoName'

/** 中身の形を変えたら上げる。古い版の summary.json は作り直す */
export const SUMMARY_VERSION = 3

/** 検索用の本文の上限。一覧のたびに全レビュー分を renderer へ送るので抑える */
export const SEARCH_TEXT_MAX = 4000

export interface StoredSummary {
  version: typeof SUMMARY_VERSION
  startedAt: string
  durationMs: number
  itemCount: number
  needsCheckCount: number
  /** Agent へ送る指摘（include=true）のID。進み具合の「完了数/対象数」に使う（版 2 から） */
  includedIds: string[]
  targetUrl?: string
  /** 録ったページのタイトル（最初の遷移のもの） */
  title?: string
  /** 自動の名前（何系の修正か。sessions/autoName.ts）。版 3 から */
  autoName?: string
  /** 検索用の本文（ページのタイトル・URL・指摘の見出しと要望と発話） */
  searchText?: string
}

export interface NavRef {
  url: string
  title: string
}

/** 重複と空を除いてつなぎ、上限で切る */
export function joinSearchText(parts: Array<string | undefined>): string | undefined {
  const text = [...new Set(parts.filter((p): p is string => !!p && p.trim().length > 0))].join('\n').slice(0, SEARCH_TEXT_MAX)
  return text || undefined
}

/** 指摘の中身を変える編集。整理が付けた名前は、これらの後には指摘と合わなくなるので使わない */
const CONTENT_EDITS = new Set(['text', 'delete', 'merge'])

/**
 * 自動の名前。整理（LLM）が付けた名前があり、その後に指摘の中身を変えていなければそれを使う。
 * 無ければ指摘からルールで作る（LLM は呼ばない）。編集を取り消せば整理の名前に戻る
 */
export function autoNameFor(record: SessionRecord, locale: SupportedLocale = getLocale()): string | undefined {
  const fromLlm = cleanReviewTitle(record.document.reviewTitle)
  if (fromLlm && !record.edits.some((e) => CONTENT_EDITS.has(e.kind))) return fromLlm
  return buildAutoName(record.document.items, locale)
}

/** session.json と遷移から、一覧用の要約を作る（純粋。単体テストから使う）。locale は自動の名前の言語の既定 */
export function buildStoredSummary(record: SessionRecord, navs: NavRef[], locale: SupportedLocale = getLocale()): StoredSummary {
  const items = record.document.items
  const title = navs.find((n) => n.title)?.title
  const autoName = autoNameFor(record, locale)
  const searchText = joinSearchText([
    autoName,
    ...navs.flatMap((n) => [n.title, n.url]),
    ...items.flatMap((i) => [i.title, i.request, ...i.quotes.map((q) => q.text)])
  ])
  return {
    version: SUMMARY_VERSION,
    startedAt: record.meta.startedAt,
    durationMs: record.meta.durationMs,
    itemCount: items.length,
    needsCheckCount: items.filter((i) => !i.include && i.status === 'needs_check').length,
    includedIds: items.filter((i) => i.include).map((i) => i.id),
    ...(record.meta.targetUrl ? { targetUrl: record.meta.targetUrl } : {}),
    ...(title ? { title } : {}),
    ...(autoName ? { autoName } : {}),
    ...(searchText ? { searchText } : {})
  }
}

/** 形が合わなければ null（作り直す） */
export function parseStoredSummary(raw: unknown): StoredSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Record<keyof StoredSummary, unknown>>
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (r.version !== SUMMARY_VERSION || typeof r.startedAt !== 'string' || !num(r.durationMs) || !num(r.itemCount) || !num(r.needsCheckCount)) return null
  if (!Array.isArray(r.includedIds) || !r.includedIds.every((id) => typeof id === 'string')) return null
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
  const targetUrl = str(r.targetUrl)
  const title = str(r.title)
  const autoName = str(r.autoName)
  const searchText = str(r.searchText)
  return {
    version: SUMMARY_VERSION,
    startedAt: r.startedAt,
    durationMs: r.durationMs as number,
    itemCount: r.itemCount as number,
    needsCheckCount: r.needsCheckCount as number,
    includedIds: r.includedIds as string[],
    ...(targetUrl ? { targetUrl } : {}),
    ...(title ? { title } : {}),
    ...(autoName ? { autoName: autoName.slice(0, AUTO_NAME_MAX) } : {}),
    ...(searchText ? { searchText: searchText.slice(0, SEARCH_TEXT_MAX) } : {})
  }
}

/** 操作ログの遷移（タイトルとURL）。nav の行だけを読む */
export async function readNavs(paths: SessionPaths): Promise<NavRef[]> {
  // 内蔵ブラウザ以外の録画には操作ログが無い（想定内）
  const text = await readFile(paths.eventsJsonl, 'utf8').catch(() => '')
  const out: NavRef[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"nav"')) continue
    try {
      const event = JSON.parse(line) as { type?: unknown; url?: unknown; title?: unknown }
      if (event.type === 'nav' && typeof event.url === 'string') out.push({ url: event.url, title: typeof event.title === 'string' ? event.title.trim() : '' })
    } catch {
      // 書きかけの行は飛ばす
    }
  }
  return out
}

/** session.json を保存したあとに呼ぶ。events.jsonl を1度だけ読んで控える */
export async function writeSummary(paths: SessionPaths, record: SessionRecord): Promise<StoredSummary> {
  const summary = buildStoredSummary(record, await readNavs(paths))
  await writeFile(paths.summaryJson, `${JSON.stringify(summary)}\n`, 'utf8')
  return summary
}

/**
 * 使える summary.json を読む。無い・壊れている・session.json より古い（控えた後に
 * session.json だけ書き換わった）ときは null を返し、呼び出し側が作り直す。
 */
export async function readFreshSummary(paths: SessionPaths): Promise<StoredSummary | null> {
  // どちらかが無ければ作り直す（想定内）
  const [summaryStat, sessionStat] = await Promise.all([
    stat(paths.summaryJson).catch(() => null),
    stat(paths.sessionJson).catch(() => null)
  ])
  if (!summaryStat || !sessionStat || summaryStat.mtimeMs < sessionStat.mtimeMs) return null
  try {
    return parseStoredSummary(JSON.parse(await readFile(paths.summaryJson, 'utf8')))
  } catch {
    // 読めない要約は session.json から作り直す（想定内）
    return null
  }
}
