import { pageKey } from './page'
import { previewPathFromUrl, previewUrl } from './preview'
import { matchPresetUrl } from './projectUrl'
import type { ProjectUrl } from './types'

/**
 * レビューの対象（URL・ファイル）。1本の録画の中で対象を切り替えながらレビューするための純粋な処理。
 *
 * - フィードバックモードの右パネルに並べる候補（登録URL・開いているファイル・最近のURL）を組み立てる
 * - 内蔵ブラウザがいまどの候補を出しているかを判定する
 * - 停止後の指摘と feedback.md を、対象ごとにまとめる
 *
 * 対象は「ページ」の単位（page.ts の pageKey。ハッシュのアンカーは同じ対象）。
 * ファイルは ade-preview:// のプレビューで内蔵ブラウザに出し、指摘ではプロジェクトからの相対パスで示す。
 */

export type ReviewTargetKind = 'url' | 'file' | 'none'

/** 指摘の対象（停止後のまとめ・feedback.md の節） */
export interface ReviewTarget {
  /** まとめるときの鍵。同じページなら同じ */
  key: string
  kind: ReviewTargetKind
  url?: string
  /** ファイルならプロジェクトからの相対パス */
  path?: string
  /** URL なら登録URLのラベル（local / dev / prd など）。当たらなければ無い */
  label?: string
  /** 見出しに出す短い名前（ファイルは相対パス、URL はホストより後ろ） */
  name: string
  /** URL のホスト（ポート込み） */
  host?: string
}

/** 指摘の URL から対象を決める。URL が無ければ「対象なし」（画面全体の録画など） */
export function targetOfUrl(url: string | undefined, presets: readonly ProjectUrl[] = []): ReviewTarget {
  if (!url) return { key: 'none', kind: 'none', name: '' }
  const path = previewPathFromUrl(url)
  if (path) return { key: `file:${path}`, kind: 'file', url, path, name: path }
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  const preset = matchPresetUrl([...presets], url)
  const name = parsed ? `${parsed.pathname}${parsed.search}` || '/' : url
  return {
    key: `url:${pageKey(url)}`,
    kind: 'url',
    url,
    name,
    ...(parsed?.host ? { host: parsed.host } : {}),
    ...(preset ? { label: preset.label } : {})
  }
}

/** 見出し1行（例「dev · example.com/pricing」「docs/a.md」） */
export function targetHeading(target: ReviewTarget): string {
  if (target.kind === 'file') return target.name
  if (target.kind === 'none') return ''
  const where = `${target.host ?? ''}${target.name === '/' ? '' : target.name}` || target.name
  return target.label ? `${target.label} · ${where}` : where
}

/**
 * 指摘を対象ごとにまとめる。対象の並びは最初に出てきた順、中の並びは元の順のまま。
 */
export function groupByTarget<T>(
  items: readonly T[],
  urlOf: (item: T) => string | undefined,
  presets: readonly ProjectUrl[] = []
): Array<{ target: ReviewTarget; items: T[] }> {
  const groups = new Map<string, { target: ReviewTarget; items: T[] }>()
  for (const item of items) {
    const target = targetOfUrl(urlOf(item), presets)
    const group = groups.get(target.key)
    if (group) group.items.push(item)
    else groups.set(target.key, { target, items: [item] })
  }
  return [...groups.values()]
}

// ───────────────────────── 右パネルの候補 ─────────────────────────

export type TargetEntryGroup = 'preset' | 'file' | 'recent'

export interface TargetEntry {
  /** 一覧の中で一意（ページの鍵か、開けないファイルなら file:<path>） */
  id: string
  kind: 'url' | 'file'
  group: TargetEntryGroup
  /** 1行目 */
  title: string
  /** 2行目（URL・相対パス） */
  detail: string
  /** 登録URLのラベル（local / dev / prd） */
  label?: string
  /** 内蔵ブラウザで開く URL（ファイルは ade-preview:// のプレビュー） */
  url?: string
  /** ファイルなら相対パス */
  path?: string
}

export interface TargetEntryInput {
  /** 今のプロジェクトの登録URL */
  presets: readonly ProjectUrl[]
  /** エディタで開いているファイルと、パネルに足したファイル（相対パス） */
  files: readonly string[]
  /** 最近開いた URL（新しい順） */
  recent: readonly string[]
  /** 内蔵ブラウザがいま出している URL（まだどの候補にも無ければ最近の先頭に足す） */
  currentUrl?: string
}

/**
 * ファイルの候補。ade-preview:// は md / Mermaid を描き、それ以外のテキストは読み取り専用のコードとして出す
 * （バイナリ・大きすぎるファイルは理由の文だけ）。どのファイルも内蔵ブラウザで開いて録画できる。
 */
function fileEntry(path: string): TargetEntry {
  const url = previewUrl(path)
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { id: pageKey(url), kind: 'file', group: 'file', title: name, detail: path, path, url }
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** 右パネルに並べる候補。登録URL → ファイル → 最近のURL の順で、同じページは1つにまとめる */
export function buildTargetEntries(input: TargetEntryInput): TargetEntry[] {
  const out: TargetEntry[] = []
  const seen = new Set<string>()
  const push = (entry: TargetEntry) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    out.push(entry)
  }
  for (const preset of input.presets) {
    if (!isWebUrl(preset.url)) continue
    push({ id: pageKey(preset.url), kind: 'url', group: 'preset', title: preset.label || preset.url, detail: preset.url, label: preset.label, url: preset.url })
  }
  for (const path of input.files) push(fileEntry(path))
  const recent = input.currentUrl ? [input.currentUrl, ...input.recent] : [...input.recent]
  for (const url of recent) {
    const path = previewPathFromUrl(url)
    if (path) {
      push(fileEntry(path))
      continue
    }
    if (!isWebUrl(url)) continue
    const preset = matchPresetUrl([...input.presets], url)
    let title = url
    try {
      const parsed = new URL(url)
      title = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
    } catch {
      // URL として読めないものはそのまま
    }
    push({ id: pageKey(url), kind: 'url', group: 'recent', title, detail: url, url, ...(preset ? { label: preset.label } : {}) })
  }
  return out
}

/** 検索欄の語で絞る（空白で区切った語をすべて含むもの。大文字小文字は問わない） */
export function filterTargetEntries(entries: readonly TargetEntry[], query: string): TargetEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...entries]
  return entries.filter((entry) => {
    const text = [entry.title, entry.detail, entry.label].filter(Boolean).join('\n').toLowerCase()
    return terms.every((term) => text.includes(term))
  })
}

/** 内蔵ブラウザがいまこの候補を出しているか（同じページか） */
export function isCurrentEntry(entry: TargetEntry, currentUrl: string | undefined): boolean {
  return !!entry.url && !!currentUrl && pageKey(entry.url) === pageKey(currentUrl)
}

/** ↑↓ で選びを動かす。端では止める。候補が無ければ -1 */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (index < 0) return delta > 0 ? 0 : length - 1
  return Math.max(0, Math.min(length - 1, index + delta))
}

/** 最近開いた URL を更新する（先頭に足し、同じページは1つにし、上限で切る） */
export function pushRecentUrl(recent: readonly string[], url: string, max = 8): string[] {
  if (!url || url === 'about:blank') return [...recent]
  const key = pageKey(url)
  return [url, ...recent.filter((u) => pageKey(u) !== key)].slice(0, max)
}
