import type { TargetEntry, UrlTreeGroup, UrlTreeNode } from './reviewTarget'

/**
 * レビュー対象パネル（ReviewTargetsPanel）の並べ方。画面に依らない部分だけをここに置き、単体テストで確かめる。
 *
 * 1. 登録した確認先（local / dev / prd・自由な名前・ウインドウ）は、件数にかかわらず全部をまとめて先頭に並べる。
 *    以前は確認先ごとにその下へ見たページの木（最大 200 行）を差し込んでいたため、
 *    1つの確認先のページが多いと、ほかの確認先が木の後ろへ押し出されて「登録した URL が出ていない」ように見えた。
 * 2. 見たページ（確認先ごとの木）と最近開いた URL は、まとまりごとに先頭の 5 件だけを出し、
 *    残りは「もっと表示（残り N 件）」で開く（開いたあとは「折りたたむ」で戻す）。
 * 3. 検索は畳んだ行も含めて全部から探す（ここでは並べ方だけを決め、検索は reviewPanelSearch.ts）。
 */

/** 畳んでいるときに、まとまりごとに出す件数 */
export const COLLAPSED_LIMIT = 5

/** 「もっと表示」の開閉を覚える鍵。見たページは確認先ごと、最近開いた URL は1つ */
export const pagesMoreKey = (groupId: string) => `pages:${groupId}`
export const RECENT_MORE_KEY = 'recent'

/**
 * 畳んでいるときは先頭の limit 件だけ、開いていれば全部。
 * rest は隠れている件数。toggle は「もっと表示 / 折りたたむ」の行を出すか（件数が limit を超えるときだけ）。
 */
export function collapseList<T>(items: readonly T[], expanded: boolean, limit = COLLAPSED_LIMIT): { shown: T[]; rest: number; toggle: boolean } {
  const max = Math.max(0, Math.floor(limit))
  if (items.length <= max) return { shown: [...items], rest: 0, toggle: false }
  if (expanded) return { shown: [...items], rest: 0, toggle: true }
  return { shown: items.slice(0, max), rest: items.length - max, toggle: true }
}

export type LayoutItem =
  | { type: 'target'; entry: TargetEntry }
  | { type: 'pagesHead'; groupId: string; label: string; url: string }
  | { type: 'page'; groupId: string; node: UrlTreeNode }
  | { type: 'recent'; url: string }
  | { type: 'more'; key: string; rest: number; expanded: boolean }

export interface ReviewPanelLayout {
  /** 登録した確認先（全部・登録した順） */
  targets: LayoutItem[]
  /** 確認先ごとの見たページ（見出し → 先頭 5 件 → もっと表示） */
  pages: LayoutItem[]
  /** 最近開いた URL（先頭 5 件 → もっと表示） */
  recent: LayoutItem[]
}

/**
 * パネルに並べる行を決める。
 * groups は buildUrlTree の結果。登録外のオリジン（registered: false）は「最近開いた URL」に出るので、ここでは並べない。
 * expanded は「もっと表示」で開いているまとまりの鍵（pagesMoreKey / RECENT_MORE_KEY）。
 */
export function layoutReviewPanel(input: {
  targets: readonly TargetEntry[]
  groups: readonly UrlTreeGroup[]
  recent: readonly string[]
  expanded: ReadonlySet<string>
  limit?: number
}): ReviewPanelLayout {
  const limit = input.limit ?? COLLAPSED_LIMIT
  const targets: LayoutItem[] = input.targets.map((entry) => ({ type: 'target', entry }))

  const pages: LayoutItem[] = []
  for (const group of input.groups) {
    if (!group.registered || group.nodes.length === 0) continue
    const key = pagesMoreKey(group.id)
    const open = input.expanded.has(key)
    const { shown, rest, toggle } = collapseList(group.nodes, open, limit)
    pages.push({ type: 'pagesHead', groupId: group.id, label: group.label, url: group.url })
    for (const node of shown) pages.push({ type: 'page', groupId: group.id, node })
    if (toggle) pages.push({ type: 'more', key, rest, expanded: open })
  }

  const recent: LayoutItem[] = []
  const recentOpen = input.expanded.has(RECENT_MORE_KEY)
  const r = collapseList(input.recent, recentOpen, limit)
  for (const url of r.shown) recent.push({ type: 'recent', url })
  if (r.toggle) recent.push({ type: 'more', key: RECENT_MORE_KEY, rest: r.rest, expanded: recentOpen })

  return { targets, pages, recent }
}

/** 「もっと表示」の開閉を切り替えた、新しい集合 */
export function toggleExpanded(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
