/**
 * ダッシュボードを JSON で自由に作る（src/shared/dashboardLayout.ts・src/main/orchestraOverview.ts の readDashboard）。
 * オーケストラのフォルダの .ferret/dashboard.json。無い・壊れていれば今までの並び。中身は文字として出す
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SECTIONS, DEFAULT_SECTIONS, MAX_NOTE_BYTES, parseDashboard, safeNotePath } from '../../src/shared/dashboardLayout'
import { readDashboard } from '../../src/main/orchestraOverview'

describe('dashboard.json の形', () => {
  it('組み込みの部品と自由な部品を順に読み、知らない・壊れた部品は捨てる', () => {
    const sections = parseDashboard({ sections: [
      { type: 'costs' },
      { type: 'metrics', title: '今週', items: [{ label: '売上', value: 1200, hint: '+8%' }, { label: '', value: 'x' }, 'bad'] },
      { type: 'note', file: 'notes/today.md' },
      { type: 'links', items: [{ label: 'Stripe', url: 'https://dashboard.stripe.com' }, { label: 'x', url: 'http://a.example' }, { label: 'y', url: 'javascript:alert(1)' }, { url: 'https://u:p@a.example' }] },
      { type: 'table', columns: ['製品', '版'], rows: [['shop', '1.2.0', 'extra'], ['blog'], 'bad'] },
      { type: 'html', html: '<script>' },
      { type: 'metrics', items: [] },
      null
    ] })
    expect(sections).toEqual([
      { type: 'costs' },
      { type: 'metrics', title: '今週', items: [{ label: '売上', value: '1200', hint: '+8%' }] },
      { type: 'note', file: 'notes/today.md' },
      { type: 'links', items: [{ label: 'Stripe', url: 'https://dashboard.stripe.com' }] },
      { type: 'table', columns: ['製品', '版'], rows: [['shop', '1.2.0'], ['blog', '']] }
    ])
  })

  it('配列だけでも読む。部品が1つも残らない・形が違うものは null（今までの並び）', () => {
    expect(parseDashboard([{ type: 'checklist' }])).toEqual([{ type: 'checklist' }])
    for (const bad of [null, 'x', 1, {}, { sections: 'x' }, { sections: [] }, { sections: [{ type: 'nope' }] }]) expect(parseDashboard(bad)).toBeNull()
  })

  it('長い文字・制御文字・部品の数を抑える', () => {
    const many = parseDashboard({ sections: Array.from({ length: 100 }, () => ({ type: 'stats', title: `a\u0007${'x'.repeat(200)}` })) })!
    expect(many).toHaveLength(40)
    expect((many[0] as { title: string }).title).toHaveLength(80)
    expect((many[0] as { title: string }).title.includes('\u0007')).toBe(false)
  })

  it('今までの並びは組み込みの部品を全部', () => {
    expect(DEFAULT_SECTIONS.map((s) => s.type)).toEqual([...BUILTIN_SECTIONS])
  })

  it('note のファイルはオーケストラのフォルダからの相対パスだけ', () => {
    expect(safeNotePath('notes/./today.md')).toBe('notes/today.md')
    expect(safeNotePath(' a.md ')).toBe('a.md')
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a/..', 'C:/x', 'a\\b', 'a\0b', '.', 'x'.repeat(301), 3, null]) expect(safeNotePath(bad), String(bad)).toBeNull()
  })
})

describe('dashboard.json を読む（main）', () => {
  it('無ければ今までの並び、壊れていれば invalid、note はファイルの中身（無い・大きすぎるものは null）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferret-dashboard-'))
    try {
      expect(await readDashboard(dir)).toEqual({ sections: DEFAULT_SECTIONS, notes: {}, custom: false })
      expect(await readDashboard(null)).toMatchObject({ custom: false })
      await mkdir(join(dir, '.ferret'))
      await writeFile(join(dir, '.ferret', 'dashboard.json'), '{broken')
      expect(await readDashboard(dir)).toMatchObject({ sections: DEFAULT_SECTIONS, invalid: true, custom: true })
      await mkdir(join(dir, 'notes'))
      await writeFile(join(dir, 'notes', 'today.md'), '# 今日\n- <b>そのまま</b>')
      await writeFile(join(dir, 'big.md'), 'x'.repeat(MAX_NOTE_BYTES + 1))
      await writeFile(join(dir, '.ferret', 'dashboard.json'), JSON.stringify({ sections: [
        { type: 'note', file: 'notes/today.md' }, { type: 'note', file: 'missing.md' }, { type: 'note', file: 'big.md' }, { type: 'note', file: 'notes' }, { type: 'note', file: '../outside.md' }
      ] }))
      const layout = await readDashboard(dir)
      expect(layout.custom).toBe(true)
      expect(layout.invalid).toBeUndefined()
      expect(layout.sections.map((s) => (s as { file: string }).file)).toEqual(['notes/today.md', 'missing.md', 'big.md', 'notes'])
      expect(layout.notes).toEqual({ 'notes/today.md': '# 今日\n- <b>そのまま</b>', 'missing.md': null, 'big.md': null, notes: null })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
