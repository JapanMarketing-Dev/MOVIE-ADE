/**
 * 「＋」メニューの検索欄の絞り込み（Orca由来の入口を本システム向けに抜き出したもの）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildQuickLaunchEntries,
  classifyUrlQuery,
  matchesQuery,
  type QuickLaunchSources
} from '../../src/renderer/terminal/quickLaunchSearch'

const sources: QuickLaunchSources = {
  agents: [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' }
  ],
  settings: true,
  tabs: [
    { key: 'tab1', title: 'Claude Code' },
    { key: 'tab2', title: '2: zsh' }
  ],
  urls: [
    { label: 'local', url: 'http://localhost:3000', project: 'shop' },
    { label: 'prd', url: 'https://shop.example.com', project: 'shop' }
  ],
  files: ['src/App.tsx']
}

describe('matchesQuery', () => {
  it('空白で区切った語がすべて含まれれば一致（大文字小文字は無視）', () => {
    expect(matchesQuery('cla code', 'Claude Code')).toBe(true)
    expect(matchesQuery('codex', 'Claude Code')).toBe(false)
  })
})

describe('classifyUrlQuery', () => {
  it('http(s) 付きはそのまま、スキーム無しは補う', () => {
    expect(classifyUrlQuery('https://example.com/a')).toBe('https://example.com/a')
    expect(classifyUrlQuery('localhost:5173')).toBe('http://localhost:5173/')
    expect(classifyUrlQuery('192.168.0.10:8080/x')).toBe('http://192.168.0.10:8080/x')
    expect(classifyUrlQuery('example.com')).toBe('https://example.com/')
  })

  it('ファイル名・普通の語・ほかのスキームはURLにしない', () => {
    expect(classifyUrlQuery('index.ts')).toBeNull()
    expect(classifyUrlQuery('claude')).toBeNull()
    expect(classifyUrlQuery('ftp://example.com')).toBeNull()
    expect(classifyUrlQuery('a b.com')).toBeNull()
  })
})

describe('buildQuickLaunchEntries', () => {
  it('空のときはメニューの項目だけ', () => {
    expect(buildQuickLaunchEntries('', sources).map((e) => e.kind)).toEqual(['shell', 'agent', 'agent', 'settings'])
  })

  it('Agent・開いているタブ・URL・ファイルを絞り込む', () => {
    // ファイルは検索済みの結果がそのまま来る（ここでは絞り込まない）ので、空で確かめる
    const noFiles = { ...sources, files: [] }
    const claude = buildQuickLaunchEntries('claude', noFiles)
    expect(claude).toEqual([
      { kind: 'agent', agent: 'claude', label: 'Claude Code' },
      { kind: 'tab', tabKey: 'tab1', title: 'Claude Code' }
    ])
    expect(buildQuickLaunchEntries('prd', noFiles)).toEqual([
      { kind: 'url', label: 'prd', url: 'https://shop.example.com', project: 'shop' }
    ])
    expect(buildQuickLaunchEntries('ターミナル', noFiles)).toEqual([{ kind: 'shell' }])
  })

  it('入力がURLなら先頭に「URLを開く」を出す', () => {
    expect(buildQuickLaunchEntries('localhost:3000', sources)[0]).toEqual({
      kind: 'open-url',
      url: 'http://localhost:3000/'
    })
  })

  it('ファイル検索の結果を最後に並べる', () => {
    const entries = buildQuickLaunchEntries('app', sources)
    expect(entries[entries.length - 1]).toEqual({ kind: 'file', path: 'src/App.tsx' })
  })
})
