/**
 * 全体のダッシュボード：人の確認リスト（human.md。src/shared/humanChecklist.ts）とコストの概算（src/shared/agentCost.ts・src/main/orchestraOverview.ts）
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHumanChecklist, uniqueByUrl } from '../../src/shared/humanChecklist'
import { EMPTY_PERIODS, EMPTY_TOTALS, addTranscriptLine, addTranscriptLineByPeriod, formatUsd, periodStarts, priceFor, sumTotals, transcriptDirName } from '../../src/shared/agentCost'
import { projectCost, readChecklist } from '../../src/main/orchestraOverview'

const HUMAN = `# 人が確かめること

## B. 価値の確認（実際に触ってほしい）

| # | 製品 | URL | 見てほしいこと |
|---|---|---|---|
| B1 | 営業企業DB | [https://d1u17ms3mxox2v.cloudfront.net](https://d1u17ms3mxox2v.cloudfront.net) | 検索の速さ、スマホでの見え方 |
| B2 | **ABMターゲット選定** | https://abm-targeting-dev.example.workers.dev | 製品を登録して候補を出す |
| B3 | 営業インテント | https://sales-intent-dev.example.workers.dev | ログインと優先順位 |

- [ ] 入札オープン https://nyusatsu.example/ 外部リンクを実クリック
- 判断待ち：料金表（URL なし）
`

describe('人の確認リスト（human.md）', () => {
  it('表の行と箇条書きから、見出し・名前・URL・見てほしいことを取り出す。URL の無い行は入れない', () => {
    const items = parseHumanChecklist(HUMAN)
    expect(items.map((i) => [i.key, i.label, i.url])).toEqual([
      ['B1', '営業企業DB', 'https://d1u17ms3mxox2v.cloudfront.net'],
      ['B2', 'ABMターゲット選定', 'https://abm-targeting-dev.example.workers.dev'],
      ['B3', '営業インテント', 'https://sales-intent-dev.example.workers.dev'],
      ['4', '入札オープン', 'https://nyusatsu.example/']
    ])
    expect(items[0]!.note).toBe('検索の速さ、スマホでの見え方')
    expect(items[3]!.note).toBe('外部リンクを実クリック')
  })

  it('同じ URL は1件にする', () => {
    expect(uniqueByUrl(parseHumanChecklist(`${HUMAN}\n| B9 | 再掲 | https://abm-targeting-dev.example.workers.dev | x |`)).length).toBe(4)
  })
})

describe('コストの概算', () => {
  it('usage のある行だけを足し、モデルごとの単価で金額にする。壊れた行は飛ばす', () => {
    let totals = EMPTY_TOTALS
    totals = addTranscriptLine(totals, JSON.stringify({ message: { model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 } } }))
    totals = addTranscriptLine(totals, JSON.stringify({ message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1_000_000 } } }))
    totals = addTranscriptLine(totals, '{broken "usage"')
    totals = addTranscriptLine(totals, JSON.stringify({ type: 'user', message: { content: 'hi' } }))
    expect(totals.input).toBe(2_000_000)
    expect(totals.output).toBe(100_000)
    // opus: 15 + 7.5 + 1.5（キャッシュは 1 割）、sonnet: 3
    expect(totals.usd).toBeCloseTo(27, 5)
    expect(priceFor('unknown-model')).toEqual({ input: 3, output: 15 })
    expect(formatUsd(27)).toBe('$27.00')
    expect(formatUsd(1234.4)).toBe('$1234')
  })

  it('Claude Code が記録を置くフォルダの名前', () => {
    expect(transcriptDirName('/Users/taro/my.app')).toBe('-Users-taro-my-app')
  })

  it('今月・今年・総額に分け、モデル別・種類別の内訳も数える', () => {
    const now = new Date(2026, 9, 8, 12).getTime()
    const starts = periodStarts(now)
    expect(starts).toEqual({ month: new Date(2026, 9, 1).getTime(), year: new Date(2026, 0, 1).getTime() })
    const line = (model: string, at: string | null, input: number, output: number, cacheRead = 0) =>
      JSON.stringify({ ...(at ? { timestamp: at } : {}), message: { model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } } })
    let p = EMPTY_PERIODS
    p = addTranscriptLineByPeriod(p, line('claude-haiku-4-5', new Date(2026, 9, 3).toISOString(), 1_000_000, 0), now, starts) // 今月 $1
    p = addTranscriptLineByPeriod(p, line('claude-sonnet-5-5', new Date(2026, 2, 3).toISOString(), 0, 1_000_000), now, starts) // 今年 $15
    p = addTranscriptLineByPeriod(p, line('claude-opus-5-5', new Date(2025, 11, 31).toISOString(), 0, 0, 1_000_000), now, starts) // 去年 $1.5
    p = addTranscriptLineByPeriod(p, line('<script>', null, 1_000_000, 0), new Date(2026, 9, 5).getTime(), starts) // 時刻なし → ファイルの時刻（今月）$3
    expect(p.month.usd).toBeCloseTo(4, 5)
    expect(p.year.usd).toBeCloseTo(19, 5)
    expect(p.total.usd).toBeCloseTo(20.5, 5)
    expect(Object.keys(p.total.models).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'other'])
    expect(p.total.usdBy.cacheRead).toBeCloseTo(1.5, 5)
    expect(p.total.usdBy.output).toBeCloseTo(15, 5)
    expect(p.month.models['claude-sonnet-5-5']).toBeUndefined()
    const both = sumTotals([p.month, p.month])
    expect(both.usd).toBeCloseTo(8, 5)
    expect(both.models['claude-haiku-4-5']).toBeCloseTo(2, 5)
  })

  it('そのフォルダの記録を新しいものから数える。無いフォルダは 0', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ferret-cost-'))
    try {
      const folder = join(home, 'shop')
      await mkdir(folder)
      const dir = join(home, 'config', 'projects', transcriptDirName(folder))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'a.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(), message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1_000_000, output_tokens: 200_000 } } })}\n`)
      const periods = await projectCost(folder, [join(home, 'config')])
      expect(periods.total.input).toBe(1_000_000)
      expect(periods.month.usd).toBeCloseTo(2, 5)
      expect(periods.year.usd).toBeCloseTo(2, 5)
      expect((await projectCost(join(home, 'none'), [join(home, 'config')], Date.now() + 1)).total.usd).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('全体のフォルダの human.md を読む。無ければ空', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferret-human-'))
    try {
      expect(await readChecklist(dir)).toEqual({ items: [], path: null })
      await writeFile(join(dir, 'human.md'), HUMAN)
      const read = await readChecklist(dir)
      expect(read.items).toHaveLength(4)
      expect(read.path).toBe(join(dir, 'human.md'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('全体のフィードバックの帯（OrchestraDock）', () => {
  it('札が多くても画面の列は窓の幅のまま（列を固定し、帯と札の並びは縮められる）', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile(new URL('../../src/renderer/styles/app.css', import.meta.url), 'utf8')
    const block = (selector: string) => new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[2] ?? ''
    expect(block('.shell')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(block('.round-dock')).toContain('min-width: 0')
    expect(block('.orchestra-dock')).toContain('min-width: 0')
    expect(css).toMatch(/\.orchestra-dock__groups,\n\.orchestra-dock__items \{[^}]*min-width: 0[^}]*overflow-x: auto/)
  })
})

