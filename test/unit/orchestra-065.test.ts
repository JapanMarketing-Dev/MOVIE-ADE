/**
 * 0.6.5 のオーケストラ：インフラなどのコスト（src/shared/extraCost.ts）、1回の録画をプロダクトごとに分ける（src/shared/productSplit.ts）、
 * URL の無い確認項目（src/shared/humanChecklist.ts）、会話の記録の差分読み（src/main/orchestraOverview.ts）、
 * 作業の途中で閉じたターミナルの再開の印（src/shared/terminalRestore.ts）
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extraPeriods, parseCostFile, sumExtra } from '../../src/shared/extraCost'
import { productForUrl, splitByProduct } from '../../src/shared/productSplit'
import { pageItems, parseHumanChecklist, uniqueByUrl } from '../../src/shared/humanChecklist'
import { transcriptDirName } from '../../src/shared/agentCost'
import { folderExtraCost, projectCost } from '../../src/main/orchestraOverview'
import { sanitizeRestoreSnapshot } from '../../src/shared/terminalRestore'

describe('インフラなどのコスト（.ferret/costs.json）', () => {
  const now = new Date(2026, 9, 8, 12).getTime()

  it('壊れた行・額の無い行・知らない種類を捨てる（種類は other）', () => {
    expect(parseCostFile({ items: [
      { name: 'Workers', category: 'infra', monthlyUsd: 5, since: '2026-01' },
      { name: 'Domain', category: 'nope', usd: 12, date: '2026-03-01', estimate: true },
      { name: '', usd: 1, date: '2026-01-01' },
      { name: 'NoAmount', category: 'infra' },
      { name: 'BadDate', usd: 3, date: '2026/03/01' },
      { name: 'Negative', monthlyUsd: -1 },
      'x'
    ] })).toEqual([
      { name: 'Workers', category: 'infra', monthlyUsd: 5, since: '2026-01' },
      { name: 'Domain', category: 'other', usd: 12, date: '2026-03-01', estimate: true }
    ])
    expect(parseCostFile(null)).toEqual([])
  })

  it('毎月のものは since〜until（無ければ今月）の月数、1回きりは日付の月で、今月・今年・総額に分ける', () => {
    const p = extraPeriods(parseCostFile({ items: [
      { name: 'Workers', category: 'infra', monthlyUsd: 5, since: '2025-11' }, // 2025-11〜2026-10 = 12 か月、今年 10 か月
      { name: 'Sentry', category: 'service', monthlyUsd: 26, since: '2026-02', until: '2026-06' }, // 5 か月、今月は無し
      { name: 'Domain', category: 'infra', usd: 12, date: '2026-10-01' },
      { name: 'Old domain', category: 'infra', usd: 10, date: '2025-05-01' },
      { name: 'Future', category: 'other', usd: 99, date: '2026-12-01' },
      { name: 'Claude Max', category: 'ai', monthlyUsd: 200, estimate: true } // since 無し：今月だけ
    ] }), now)
    expect(p.month.usd).toBe(5 + 12 + 200)
    expect(p.year.usd).toBe(5 * 10 + 26 * 5 + 12 + 200)
    expect(p.total.usd).toBe(5 * 12 + 26 * 5 + 12 + 10 + 200)
    expect(p.month.byCategory).toEqual({ infra: 17, service: 0, ai: 200, other: 0 })
    expect(p.total.items['Workers']).toBe(60)
    expect(p.total.estimated).toBe(true)
    expect(sumExtra([p.month, p.month]).usd).toBe(434)
  })

  it('フォルダの .ferret/costs.json を読む。無い・壊れていれば 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferret-costs-'))
    try {
      expect((await folderExtraCost(dir, now)).total.usd).toBe(0)
      await mkdir(join(dir, '.ferret'))
      await writeFile(join(dir, '.ferret', 'costs.json'), '{broken')
      expect((await folderExtraCost(dir, now)).total.usd).toBe(0)
      await writeFile(join(dir, '.ferret', 'costs.json'), JSON.stringify({ items: [{ name: 'DB', category: 'infra', monthlyUsd: 15, since: '2026-10' }] }))
      expect((await folderExtraCost(dir, now)).month.usd).toBe(15)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('1回の録画をプロダクトごとに分ける', () => {
  const projects = [
    { id: 'shop', name: 'Shop', folderPath: '/w/shop', urls: [{ url: 'http://localhost:3000/' }, { url: 'https://shop.example.com' }] },
    { id: 'blog', name: 'Blog', folderPath: '/w/blog', urls: [{ url: 'http://localhost:4000' }] },
    { id: 'admin', name: 'Admin', folderPath: '/w/admin', urls: [{ url: 'https://example.com/admin' }] },
    { id: 'docs', name: 'Docs', folderPath: '/w/docs', urls: [{ url: 'https://example.com/docs/' }] }
  ]

  it('同じページ・その下のページ・同じオリジンのプロダクトが1つだけ、で決める。同じオリジンが複数ならパスで', () => {
    expect(productForUrl(projects, 'http://localhost:3000/cart?x=1')).toBe('shop')
    expect(productForUrl(projects, 'https://shop.example.com/items/3')).toBe('shop')
    expect(productForUrl(projects, 'http://localhost:4000/posts')).toBe('blog')
    expect(productForUrl(projects, 'https://example.com/admin/users')).toBe('admin')
    expect(productForUrl(projects, 'https://example.com/docs')).toBe('docs')
    expect(productForUrl(projects, 'https://example.com/pricing')).toBeNull()
    expect(productForUrl(projects, 'https://example.com/administrator')).toBeNull()
    expect(productForUrl(projects, 'http://localhost:5000/')).toBeNull()
    expect(productForUrl(projects, undefined)).toBeNull()
    expect(productForUrl(projects, 'file:///etc/passwd')).toBeNull()
  })

  it('URL の無い指摘（ウインドウを映していた）は直前のプロダクト。合わない URL は決めない。並びは登録順で、決まらないものは最後', () => {
    const shares = splitByProduct(projects, [
      { index: 3, t: 30, url: 'http://localhost:4000/a' },
      { index: 1, t: 10, url: 'http://localhost:3000/' },
      { index: 2, t: 20 },
      { index: 4, t: 40, url: 'https://unknown.example/' },
      { index: 5, t: 50 },
      { index: 6, t: 60, url: 'http://localhost:3000/b' }
    ])
    expect(shares).toEqual([
      { projectId: 'shop', indexes: [1, 2, 6] },
      { projectId: 'blog', indexes: [3, 5] },
      { projectId: null, indexes: [4] }
    ])
    // 最初が URL 無しなら決めない
    expect(splitByProduct(projects, [{ index: 1, t: 0 }])).toEqual([{ projectId: null, indexes: [1] }])
  })

  it('main は全体で録ったものをプロダクトごとに並行して送り、帯は文字のフィードバックをそのプロダクトに送る', async () => {
    const { readFile } = await import('node:fs/promises')
    const main = await readFile(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain('sendSplitByProduct(paths, data.document.items')
    expect(main).toMatch(/await Promise\.all\(jobs\)/)
    const dock = await readFile(new URL('../../src/renderer/components/OrchestraDock.tsx', import.meta.url), 'utf8')
    expect(dock).toContain('<OrchestraComposer compact product={product} />')
  })
})

describe('人の確認リスト：URL の無い項目', () => {
  const md = `# 人が確かめること

| 番号 | プロダクト | URL | 見てほしいこと |
|---|---|---|---|
| B1 | Shop | http://localhost:3000/ | カートの見た目 |
| A1 | Shop | - | 本番の DB の削除を承認 |
| P1 | Blog | — | Stripe の本番キーを用意 |
| メモ | 説明 | - | これは項目ではない |

- [ ] 料金表の文言を決める
- [x] 済んだもの
- 説明の箇条書き
`

  it('番号で始まる表の行と未チェックの - [ ] を項目にし、見出しの行・説明の行は入れない', () => {
    const items = parseHumanChecklist(md)
    expect(items.map((i) => [i.key, i.label, i.url, i.note])).toEqual([
      ['B1', 'Shop', 'http://localhost:3000/', 'カートの見た目'],
      ['A1', 'Shop', '', '本番の DB の削除を承認'],
      ['P1', 'Blog', '', 'Stripe の本番キーを用意'],
      ['4', '', '', '料金表の文言を決める']
    ])
    expect(uniqueByUrl(items)).toHaveLength(4)
    expect(pageItems(items).map((i) => i.key)).toEqual(['B1'])
  })
})

describe('会話の記録の差分読み', () => {
  it('変わっていないファイルは数え直さず、書き足した分だけを足す。途中の行は改行が来てから数える', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ferret-cost-inc-'))
    try {
      const folder = join(home, 'shop')
      await mkdir(folder)
      const config = join(home, 'config')
      const dir = join(config, 'projects', transcriptDirName(folder))
      await mkdir(dir, { recursive: true })
      const line = (input: number) => JSON.stringify({ timestamp: new Date().toISOString(), message: { model: 'claude-haiku-4-5', usage: { input_tokens: input } } })
      const file = join(dir, 'a.jsonl')
      await writeFile(file, `${line(1_000_000)}\n${line(500_000).slice(0, 20)}`)
      expect((await projectCost(folder, [config])).total.input).toBe(1_000_000)
      // 書きかけの行の続きと、新しい行
      await appendFile(file, `${line(500_000).slice(20)}\n${line(250_000)}\n`)
      expect((await projectCost(folder, [config])).total.input).toBe(1_750_000)
      // 何も変わっていなければ同じ
      expect((await projectCost(folder, [config])).total.input).toBe(1_750_000)
      // 縮んだら初めから
      await writeFile(file, `${line(100)}\n`)
      expect((await projectCost(folder, [config])).total.input).toBe(100)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('同じフォルダを同時に数えるときは1回だけ読む', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ferret-cost-once-'))
    try {
      const a = projectCost(join(home, 'x'), [home])
      const b = projectCost(join(home, 'x'), [home])
      expect(a).toBe(b)
      await a
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('作業の途中で閉じたターミナル', () => {
  it('Agent のペインの「作業の途中」の印を覚える（シェルには付けない・true 以外は捨てる）', () => {
    const snapshot = sanitizeRestoreSnapshot({
      tabs: [{ key: 'tab1', projectId: 'p', layout: { type: 'split', direction: 'vertical', ratio: 0.5, first: { type: 'leaf', leafId: 'pane1' }, second: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', leafId: 'pane2' }, second: { type: 'leaf', leafId: 'pane3' } } }, activePane: 'pane1' }],
      panes: [
        { key: 'pane1', title: 'Claude', launch: 'claude', cwd: null, accountId: null, scrollback: '', working: true },
        { key: 'pane2', title: 'zsh', launch: null, cwd: null, accountId: null, scrollback: '', working: true },
        { key: 'pane3', title: 'Codex', launch: 'codex', cwd: null, accountId: null, scrollback: '', working: 'yes' }
      ],
      activeByProject: {},
      savedAt: Date.now()
    })!
    expect(snapshot.panes.map((p) => p.working ?? false)).toEqual([true, false, false])
  })

  it('戻したペインは続きを頼み、PC のスリープから戻ったら止まっている Agent に続きを頼む', async () => {
    const { readFile } = await import('node:fs/promises')
    const pane = await readFile(new URL('../../src/renderer/components/TerminalPane.tsx', import.meta.url), 'utf8')
    expect(pane).toContain("window.ade.invoke('terminal:continueWork', info.id)")
    const main = await readFile(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain("powerMonitor.on('suspend', () => void rememberWorkBeforeSleep())")
    expect(main).toMatch(/state\.state === 'idle'\) await terminals!\.sendReview\(id, t\('terminal\.continueWork'\)\)/)
  })
})
