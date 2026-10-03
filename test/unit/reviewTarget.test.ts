import { describe, expect, it } from 'vitest'
import {
  buildTargetEntries,
  filterTargetEntries,
  groupByTarget,
  isCurrentEntry,
  moveSelection,
  pushRecentUrl,
  targetHeading,
  targetOfUrl
} from '../../src/shared/reviewTarget'
import type { ProjectUrl } from '../../src/shared/types'

const presets: ProjectUrl[] = [
  { id: 'l', label: 'local', url: 'http://localhost:3000/' },
  { id: 'd', label: 'dev', url: 'https://dev.example.com/' },
  { id: 'p', label: 'prd', url: 'https://example.com/' }
]

describe('指摘の対象', () => {
  it('URL は登録URLのラベルとパス。同じページ（アンカー違い）は同じ対象', () => {
    const a = targetOfUrl('https://dev.example.com/pricing?plan=a#top', presets)
    expect(a).toMatchObject({ kind: 'url', label: 'dev', host: 'dev.example.com', name: '/pricing?plan=a' })
    expect(targetOfUrl('https://dev.example.com/pricing?plan=a', presets).key).toBe(a.key)
    expect(targetOfUrl('https://example.com/pricing?plan=a', presets).key).not.toBe(a.key)
    expect(targetHeading(a)).toBe('dev · dev.example.com/pricing?plan=a')
  })

  it('ファイルのプレビューは相対パス', () => {
    const f = targetOfUrl('ade-preview://project/docs/%E8%A8%AD%E8%A8%88.md', presets)
    expect(f).toMatchObject({ kind: 'file', path: 'docs/設計.md', key: 'file:docs/設計.md' })
    expect(targetHeading(f)).toBe('docs/設計.md')
  })

  it('登録の無いURLはラベル無し。URLが無ければ「対象なし」', () => {
    expect(targetHeading(targetOfUrl('http://127.0.0.1:5173/', presets))).toBe('127.0.0.1:5173')
    expect(targetOfUrl(undefined)).toMatchObject({ key: 'none', kind: 'none' })
  })

  it('指摘を対象ごとにまとめる。対象は最初に出た順、中は元の順', () => {
    const items = [
      { id: 1, url: 'http://localhost:3000/' },
      { id: 2, url: 'ade-preview://project/README.md' },
      { id: 3, url: 'http://localhost:3000/#faq' },
      { id: 4, url: 'https://example.com/' },
      { id: 5, url: undefined }
    ]
    const groups = groupByTarget(items, (i) => i.url, presets)
    expect(groups.map((g) => [g.target.label ?? g.target.kind, g.items.map((i) => i.id)])).toEqual([
      ['local', [1, 3]],
      ['file', [2]],
      ['prd', [4]],
      ['none', [5]]
    ])
  })
})

describe('右パネルの候補', () => {
  const entries = buildTargetEntries({
    presets,
    files: ['README.md', 'docs/flow.mmd', 'src/app.ts'],
    recent: ['https://dev.example.com/pricing', 'https://dev.example.com/', 'ade-preview://project/docs/old.md', 'about:blank'],
    currentUrl: 'http://127.0.0.1:5173/admin'
  })

  it('登録URL → ファイル → 最近 の順。同じページは1つ', () => {
    expect(entries.map((e) => `${e.group}:${e.title}`)).toEqual([
      'preset:local', 'preset:dev', 'preset:prd',
      'file:README.md', 'file:flow.mmd', 'file:app.ts',
      'recent:127.0.0.1:5173/admin', 'recent:dev.example.com/pricing', 'file:old.md'
    ])
  })

  it('ファイルはプレビューのURLで開ける（md / mermaid 以外も読み取り専用のコードとして出る）', () => {
    expect(entries.find((e) => e.path === 'README.md')?.url).toBe('ade-preview://project/README.md')
    expect(entries.find((e) => e.path === 'src/app.ts')?.url).toBe('ade-preview://project/src/app.ts')
  })

  it('最近のURLにも、登録URLの下ならラベルが付く', () => {
    expect(entries.find((e) => e.detail === 'https://dev.example.com/pricing')?.label).toBe('dev')
  })

  it('検索で絞る（タイトル・URL・ラベル）', () => {
    expect(filterTargetEntries(entries, 'prd').map((e) => e.title)).toEqual(['prd'])
    expect(filterTargetEntries(entries, 'DOCS').map((e) => e.title)).toEqual(['flow.mmd', 'old.md'])
    expect(filterTargetEntries(entries, 'dev pricing').map((e) => e.title)).toEqual(['dev.example.com/pricing'])
    expect(filterTargetEntries(entries, '')).toHaveLength(entries.length)
  })
})

describe('切り替えの判定と操作', () => {
  it('同じページを出していれば「いまの対象」（アンカー違いも同じ）', () => {
    const local = { id: 'x', kind: 'url' as const, group: 'preset' as const, title: 'local', detail: '', url: 'http://localhost:3000/' }
    expect(isCurrentEntry(local, 'http://localhost:3000/#a')).toBe(true)
    expect(isCurrentEntry(local, 'http://localhost:3000/login')).toBe(false)
    expect(isCurrentEntry({ ...local, url: undefined }, 'http://localhost:3000/')).toBe(false)
  })

  it('↑↓ の選びは端で止まる', () => {
    expect(moveSelection(-1, 1, 3)).toBe(0)
    expect(moveSelection(-1, -1, 3)).toBe(2)
    expect(moveSelection(2, 1, 3)).toBe(2)
    expect(moveSelection(0, -1, 3)).toBe(0)
    expect(moveSelection(0, 1, 0)).toBe(-1)
  })

  it('最近のURLは先頭に足し、同じページは1つ、上限で切る', () => {
    expect(pushRecentUrl(['https://a.test/', 'https://b.test/'], 'https://b.test/#x')).toEqual(['https://b.test/#x', 'https://a.test/'])
    expect(pushRecentUrl(['a', 'b'], 'about:blank')).toEqual(['a', 'b'])
    expect(pushRecentUrl(Array.from({ length: 10 }, (_, i) => `https://s${i}.test/`), 'https://new.test/', 8)).toHaveLength(8)
  })
})

describe('URL の無い確認先（ウインドウ・起動コマンド）', () => {
  const targets: ProjectUrl[] = [
    { id: 'w', label: 'iOS sim', launchCommand: 'open -a Simulator', windowMatch: 'Simulator' },
    { id: 'm', label: 'mobile web', url: 'http://localhost:8081/', windowMatch: 'Expo' },
    { id: 'c', label: 'build only', launchCommand: 'pnpm build' }
  ]

  it('モバイルなどの種類では、ウインドウの確認先も並べる（押すと targetAction に従う）', () => {
    const entries = buildTargetEntries({ presets: targets, projectKind: 'mobile', files: [], recent: [] })
    expect(entries.map((e) => [e.kind, e.title, e.windowMatch ?? null, e.launchCommand ?? null, e.url ?? null])).toEqual([
      ['window', 'iOS sim', 'Simulator', 'open -a Simulator', null],
      ['window', 'mobile web', 'Expo', null, 'http://localhost:8081/'],
      ['window', 'build only', null, 'pnpm build', null]
    ])
  })

  it('Web のプロジェクトでは起動コマンド・ウインドウを使わないので、URL の無い確認先は出さない', () => {
    const entries = buildTargetEntries({ presets: targets, files: [], recent: [] })
    expect(entries.map((e) => [e.kind, e.title])).toEqual([['url', 'mobile web']])
  })
})
