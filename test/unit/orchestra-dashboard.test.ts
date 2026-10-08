/**
 * 全体のダッシュボード：人の確認リスト（human.md。src/shared/humanChecklist.ts）とコストの概算（src/shared/agentCost.ts・src/main/orchestraOverview.ts）
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHumanChecklist, uniqueByUrl } from '../../src/shared/humanChecklist'
import { EMPTY_TOTALS, addTranscriptLine, formatUsd, priceFor, transcriptDirName } from '../../src/shared/agentCost'
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

  it('そのフォルダの直近の記録を数える。古い記録は数えない', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ferret-cost-'))
    try {
      const folder = join(home, 'shop')
      await mkdir(folder)
      const dir = join(home, 'config', 'projects', transcriptDirName(folder))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'a.jsonl'), `${JSON.stringify({ message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1_000_000, output_tokens: 200_000 } } })}\n`)
      const totals = await projectCost(folder, [join(home, 'config')])
      expect(totals.input).toBe(1_000_000)
      expect(totals.usd).toBeCloseTo(2, 5)
      expect((await projectCost(join(home, 'none'), [join(home, 'config')], Date.now() + 1)).usd).toBe(0)
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
    expect(block('.orchestra-dock__chips')).toMatch(/min-width: 0[\s\S]*overflow-x: auto/)
  })
})

