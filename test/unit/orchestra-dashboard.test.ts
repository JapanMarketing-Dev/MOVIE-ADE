/**
 * 全体のダッシュボード：人の確認リスト（human.md。src/shared/humanChecklist.ts）（src/main/orchestraOverview.ts）
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHumanChecklist, uniqueByUrl } from '../../src/shared/humanChecklist'
import { readChecklist } from '../../src/main/orchestraOverview'

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

describe('全体のフォルダの human.md', () => {
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

