/**
 * 0.6.5 のオーケストラ：インフラなどのコスト（src/shared/extraCost.ts）、1回の録画をプロダクトごとに分ける（src/shared/productSplit.ts）、
 * URL の無い確認項目（src/shared/humanChecklist.ts）、
 * 作業の途中で閉じたターミナルの再開の印（src/shared/terminalRestore.ts）
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { costForecast, extraPeriods, parseCostFile, parseCosts, providerOf, sumExtra, sumForecast } from '../../src/shared/extraCost'
import { productForUrl, splitByProduct } from '../../src/shared/productSplit'
import { pageItems, parseHumanChecklist, uniqueByUrl } from '../../src/shared/humanChecklist'
import { folderCosts } from '../../src/main/orchestraOverview'
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
      { name: 'Workers', category: 'infra', provider: 'Cloudflare', monthlyUsd: 5, since: '2026-01' },
      { name: 'Domain', category: 'other', provider: '', usd: 12, date: '2026-03-01', estimate: true }
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
    // AI（サブスク）は数えない
    expect(p.month.usd).toBe(5 + 12)
    expect(p.year.usd).toBe(5 * 10 + 26 * 5 + 12)
    expect(p.total.usd).toBe(5 * 12 + 26 * 5 + 12 + 10)
    expect(p.month.byCategory).toEqual({ infra: 17, service: 0, other: 0 })
    expect(p.total.items['Workers']).toBe(60)
    expect(p.total.items['Claude Max']).toBeUndefined()
    expect(p.total.byProvider).toEqual({ Cloudflare: 60, Sentry: 130, '': 22 })
    expect(p.total.estimated).toBe(false)
    expect(sumExtra([p.month, p.month]).usd).toBe(34)
  })

  it('フォルダの .ferret/costs.json を読む。無い・壊れていれば 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferret-costs-'))
    try {
      expect((await folderCosts(dir, now)).periods.total.usd).toBe(0)
      await mkdir(join(dir, '.ferret'))
      await writeFile(join(dir, '.ferret', 'costs.json'), '{broken')
      expect((await folderCosts(dir, now)).forecast.usd).toBe(0)
      await writeFile(join(dir, '.ferret', 'costs.json'), JSON.stringify({
        items: [{ name: 'DB', category: 'infra', monthlyUsd: 15, since: '2026-10' }],
        checkedAt: '2026-10-08',
        estimates: [{ name: 'EC2 t3.small ×2', provider: 'aws', monthlyUsd: 30.4, basis: '$0.0208/h × 730h × 2' }]
      }))
      const costs = await folderCosts(dir, now)
      expect(costs.periods.month.usd).toBe(15)
      expect(costs.forecast).toMatchObject({ usd: 30.4, byProvider: { AWS: 30.4 }, checkedAt: '2026-10-08', fromRecurring: false })
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
    const split = await readFile(new URL('../../src/main/productSplitSend.ts', import.meta.url), 'utf8')
    expect(split).toMatch(/await Promise\.all\(jobs\)/)
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

describe('今のリソースからの推定の月額', () => {
  const now = new Date(2026, 9, 8, 12).getTime()

  it('estimates があればそれだけを足す。AI と額の無いものは捨てる', () => {
    const f = costForecast(parseCosts({
      items: [{ name: 'Workers', category: 'infra', monthlyUsd: 5, since: '2026-01' }],
      checkedAt: '2026-10-08',
      estimates: [
        { name: 'EC2 t3.small', provider: 'Amazon Web Services', monthlyUsd: 15.2, basis: '$0.0208/h × 730h' },
        { name: 'Cloud Run api', provider: 'gcp', monthlyUsd: 8 },
        { name: 'R2 bucket', monthlyUsd: 1.5 },
        { name: 'OpenAI', category: 'ai', monthlyUsd: 20 },
        { name: 'NoAmount' }
      ]
    }), now)
    expect(f.usd).toBeCloseTo(24.7, 5)
    expect(f.byProvider).toEqual({ AWS: 15.2, 'Google Cloud': 8, Cloudflare: 1.5 })
    expect(f.basis).toEqual({ 'EC2 t3.small': '$0.0208/h × 730h' })
    expect(f.checkedAt).toBe('2026-10-08')
    expect(f.fromRecurring).toBe(false)
  })

  it('estimates が無ければ今月も続いている毎月の items を使う（終わったもの・1回きりは入れない）', () => {
    const f = costForecast(parseCosts({ items: [
      { name: 'Workers', provider: 'Cloudflare', category: 'infra', monthlyUsd: 5, since: '2026-01' },
      { name: 'Old VM', provider: 'AWS', category: 'infra', monthlyUsd: 40, since: '2026-01', until: '2026-08' },
      { name: 'Domain', category: 'infra', usd: 12, date: '2026-10-01' },
      { name: 'Claude Max', category: 'ai', monthlyUsd: 200 }
    ], checkedAt: '2026-10-08' }), now)
    expect(f).toMatchObject({ usd: 5, items: { Workers: 5 }, checkedAt: null, fromRecurring: true })
  })

  it('フォルダを足すと、調べた日は一番古いものになる', () => {
    const a = costForecast(parseCosts({ checkedAt: '2026-10-08', estimates: [{ name: 'EC2', provider: 'AWS', monthlyUsd: 10 }] }), now)
    const b = costForecast(parseCosts({ checkedAt: '2026-09-30', estimates: [{ name: 'EC2', provider: 'AWS', monthlyUsd: 5 }] }), now)
    expect(sumForecast([a, b])).toMatchObject({ usd: 15, byProvider: { AWS: 15 }, items: { EC2: 15 }, checkedAt: '2026-09-30' })
  })

  it('事業者の名前をそろえる。分からなければ書かれたまま、無ければ空', () => {
    expect(providerOf('amazon web services', 'x')).toBe('AWS')
    expect(providerOf(undefined, 'Cloudflare Workers Paid')).toBe('Cloudflare')
    expect(providerOf('Firebase', 'Hosting')).toBe('Google Cloud')
    expect(providerOf('Sakura Internet', 'VPS')).toBe('Sakura Internet')
    expect(providerOf(undefined, 'example.com domain')).toBe('')
  })
})
