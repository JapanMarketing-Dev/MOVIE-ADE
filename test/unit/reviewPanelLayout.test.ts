import { describe, expect, it } from 'vitest'
import { buildTargetEntries, buildUrlTree } from '../../src/shared/reviewTarget'
import { COLLAPSED_LIMIT, RECENT_MORE_KEY, collapseList, layoutReviewPanel, pagesMoreKey, toggleExpanded, type LayoutItem } from '../../src/shared/reviewPanelLayout'
import { searchReviewPanel } from '../../src/shared/reviewPanelSearch'
import type { ProjectUrl } from '../../src/shared/types'

// 報告のあった並び（設定は dev → prd → local。local だけ見たページが多い）
const presets: ProjectUrl[] = [
  { id: 'd', label: 'dev', url: 'https://dev.example.com/' },
  { id: 'p', label: 'prd', url: 'https://example.com/' },
  { id: 'l', label: 'local', url: 'http://localhost:4321' }
]
const localPages = Array.from({ length: 40 }, (_, i) => `http://localhost:4321/page-${String(i).padStart(2, '0')}.html`)
const history = [...localPages, 'https://dev.example.com/pricing']

const describeItem = (item: LayoutItem): string => {
  switch (item.type) {
    case 'target': return `target:${item.entry.title}`
    case 'pagesHead': return `head:${item.label}`
    case 'page': return `page:${item.node.name}`
    case 'recent': return `recent:${item.url}`
    case 'more': return `more:${item.key}:${item.rest}:${item.expanded}`
  }
}

describe('レビュー対象パネル: 登録した確認先', () => {
  const targets = buildTargetEntries({ presets, projectKind: 'web', files: [], recent: [] })
  const groups = buildUrlTree(presets, history, 'web')

  it('見たページが多くても、登録した確認先（dev / prd / local）は全部、ページの行より前にまとめて並ぶ', () => {
    const layout = layoutReviewPanel({ targets, groups, recent: history, expanded: new Set() })
    // 以前は local の下に 40 行の木を差し込み、確認先の一覧がページに埋もれていた
    expect(layout.targets.map(describeItem)).toEqual(['target:dev', 'target:prd', 'target:local'])
    expect(layout.targets.every((item) => item.type === 'target')).toBe(true)
    expect(layout.targets.map((item) => item.type === 'target' && item.entry.detail)).toEqual(['https://dev.example.com/', 'https://example.com/', 'http://localhost:4321'])
  })

  it('同じ URL を別の名前で登録しても、どちらも並ぶ', () => {
    const dup: ProjectUrl[] = [...presets, { id: 'f', label: 'Spec', url: 'http://localhost:4321/', purpose: 'doc' }]
    const entries = buildTargetEntries({ presets: dup, projectKind: 'web', files: [], recent: [] })
    expect(entries.map((e) => e.title)).toEqual(['dev', 'prd', 'local', 'Spec'])
    expect(new Set(entries.map((e) => e.id)).size).toBe(4)
    expect(entries.at(-1)?.purpose).toBe('doc')
  })

  it('ウインドウの確認先にも区分の印が付く', () => {
    const entries = buildTargetEntries({ presets: [{ id: 'w', label: 'Figma app', windowMatch: 'Figma', purpose: 'design' }], projectKind: 'desktop', files: [], recent: [] })
    expect(entries.map((e) => [e.kind, e.title, e.purpose])).toEqual([['window', 'Figma app', 'design']])
  })
})

describe('レビュー対象パネル: 見たページと最近開いた URL は 5 件まで', () => {
  const targets = buildTargetEntries({ presets, projectKind: 'web', files: [], recent: [] })
  const groups = buildUrlTree(presets, history, 'web')

  it('畳んでいるときは確認先ごとに先頭 5 件と「もっと表示（残り N 件）」', () => {
    const layout = layoutReviewPanel({ targets, groups, recent: history.slice(0, 15), expanded: new Set() })
    expect(layout.pages.map(describeItem)).toEqual([
      'head:dev', 'page:pricing',
      'head:local', ...localPages.slice(0, COLLAPSED_LIMIT).map((u) => `page:${u.split('/').pop()}`), `more:${pagesMoreKey('l')}:35:false`
    ])
    expect(layout.recent.map(describeItem)).toEqual([...history.slice(0, 5).map((u) => `recent:${u}`), `more:${RECENT_MORE_KEY}:10:false`])
  })

  it('もっと表示で全部を出し、折りたたむ行が残る。もう一度押すと畳む', () => {
    const open = toggleExpanded(new Set(), pagesMoreKey('l'))
    const layout = layoutReviewPanel({ targets, groups, recent: [], expanded: open })
    const local = layout.pages.filter((item) => item.type === 'page' && item.groupId === 'l')
    expect(local).toHaveLength(40)
    expect(layout.pages.at(-1)).toEqual({ type: 'more', key: pagesMoreKey('l'), rest: 0, expanded: true })
    expect(toggleExpanded(open, pagesMoreKey('l')).size).toBe(0)
    // 開いても登録した確認先の並びは変わらない
    expect(layout.targets.map(describeItem)).toEqual(['target:dev', 'target:prd', 'target:local'])
  })

  it('5 件以下なら「もっと表示」は出さない。登録外のオリジンは見たページに並べない', () => {
    expect(collapseList([1, 2, 3, 4, 5], false)).toEqual({ shown: [1, 2, 3, 4, 5], rest: 0, toggle: false })
    expect(collapseList([1, 2, 3, 4, 5, 6], false)).toEqual({ shown: [1, 2, 3, 4, 5], rest: 1, toggle: true })
    expect(collapseList([1, 2, 3, 4, 5, 6], true)).toEqual({ shown: [1, 2, 3, 4, 5, 6], rest: 0, toggle: true })
    const other = buildUrlTree(presets, ['https://elsewhere.test/a'], 'web')
    expect(layoutReviewPanel({ targets, groups: other, recent: [], expanded: new Set() }).pages).toEqual([])
  })

  it('検索は畳んで隠れたページからも探せる（全部の行を元にする）', () => {
    const full = layoutReviewPanel({ targets, groups, recent: [], expanded: new Set(), limit: Number.POSITIVE_INFINITY })
    const sources = full.pages.flatMap((item) => item.type === 'page' ? [{ id: item.node.key, kind: 'url' as const, text: `local ${item.node.path}` }] : [])
    const hits = searchReviewPanel('page-39', sources, [])
    expect(hits[0]?.text).toBe('local /page-39.html')
  })
})
