/**
 * オーケストレーター：すぐ下のフォルダのプロジェクトを Claude Code の subagent にする（src/shared/orchestrator.ts・src/main/orchestrator.ts）
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SUBAGENT_MARKER, childList, isFerretSubagent, orchestratorChildren, planSubagents, renderSubagent, slug } from '../../src/shared/orchestrator'
import { syncOrchestrator } from '../../src/main/orchestrator'

describe('子のプロジェクトを決める', () => {
  it('git のリポジトリか登録済みのプロジェクトだけ。隠しフォルダ・node_modules は外し、名前の順', () => {
    const children = orchestratorChildren('/w', [
      { name: 'shop', isGitRepo: true },
      { name: 'admin', isGitRepo: false },
      { name: 'notes', isGitRepo: false },
      { name: '.cache', isGitRepo: true },
      { name: 'node_modules', isGitRepo: true }
    ], [{ folderPath: '/w/admin/', name: '管理画面' }], posix.join)
    expect(children).toEqual([
      { dir: 'admin', name: '管理画面', agent: 'ferret-admin' },
      { dir: 'shop', name: 'shop', agent: 'ferret-shop' }
    ])
  })

  it('subagent の名前は英数字とハイフン。重なれば番号を付ける', () => {
    expect(slug('My Shop_v2')).toBe('my-shop-v2')
    expect(slug('管理')).toBe('project')
    const children = orchestratorChildren('/w', [{ name: '管理', isGitRepo: true }, { name: '販売', isGitRepo: true }], [], posix.join)
    expect(children.map((c) => c.agent)).toEqual(['ferret-project', 'ferret-project-2'])
  })

  it('subagent の中身：名前・説明・印・そのフォルダだけで作業する決まり', () => {
    const text = renderSubagent({ dir: 'shop', name: 'Shop "EC"', agent: 'ferret-shop' }, '/w', posix.join)
    expect(text.startsWith('---\nname: ferret-shop\ndescription: "')).toBe(true)
    expect(text).toContain("Works in the Shop 'EC' project (folder shop/)")
    expect(isFerretSubagent(text)).toBe(true)
    expect(text).toContain('`/w/shop`')
    expect(text).toContain('Do not edit files outside it')
    expect(childList([{ dir: 'shop', name: 'Shop', agent: 'ferret-shop' }])).toBe('Shop (shop/) → ferret-shop')
  })

  it('Windows：区切りと大文字・小文字が違っても登録済みのプロジェクトとして見る', () => {
    const children = orchestratorChildren('C:\\w', [{ name: 'admin', isGitRepo: false }], [{ folderPath: 'c:/W/Admin/', name: '管理画面' }], win32.join)
    expect(children).toEqual([{ dir: 'admin', name: '管理画面', agent: 'ferret-admin' }])
  })
})

describe('書く・消す・飛ばすを決める', () => {
  const ours = (body: string) => `${SUBAGENT_MARKER}\n${body}`
  it('無いものは書く。中身が同じなら書かない。利用者のものは飛ばす。子でなくなった Ferret のものは消す', () => {
    const plan = planSubagents([
      { file: 'ferret-a.md', text: ours('a') },
      { file: 'ferret-b.md', text: ours('old') },
      { file: 'ferret-c.md', text: 'mine' },
      { file: 'ferret-gone.md', text: ours('x') },
      { file: 'ferret-link.md', text: null }
    ], [
      { file: 'ferret-a.md', text: ours('a') },
      { file: 'ferret-b.md', text: ours('new') },
      { file: 'ferret-c.md', text: ours('c') },
      { file: 'ferret-d.md', text: ours('d') },
      { file: 'ferret-link.md', text: ours('l') }
    ])
    expect(plan.write.map((w) => w.file)).toEqual(['ferret-b.md', 'ferret-d.md'])
    expect(plan.skipped).toEqual(['ferret-c.md', 'ferret-link.md'])
    expect(plan.remove).toEqual(['ferret-gone.md'])
  })
})

describe('フォルダに書く', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ferret-orch-'))
    await mkdir(join(root, 'shop', '.git'), { recursive: true })
    await mkdir(join(root, 'admin'), { recursive: true })
    await writeFile(join(root, 'admin', '.git'), 'gitdir: ../.git/worktrees/admin\n') // worktree は .git がファイル
    await mkdir(join(root, 'docs'), { recursive: true })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('子ごとに .claude/agents/ferret-*.md を書き、やめると Ferret のものだけ消す', async () => {
    const dir = join(root, '.claude', 'agents')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'reviewer.md'), 'user agent')
    const on = await syncOrchestrator(root, [])
    expect(on.children.map((c) => c.dir)).toEqual(['admin', 'shop'])
    expect(on.written.sort()).toEqual(['ferret-admin.md', 'ferret-shop.md'])
    expect(await readFile(join(dir, 'ferret-shop.md'), 'utf8')).toContain(join(root, 'shop'))
    // 2回目は書かない
    expect((await syncOrchestrator(root, [])).written).toEqual([])
    // 子が減ったら消す
    await rm(join(root, 'admin'), { recursive: true })
    expect((await syncOrchestrator(root, [])).removed).toEqual(['ferret-admin.md'])
    const off = await syncOrchestrator(root, [], false)
    expect(off.removed).toEqual(['ferret-shop.md'])
    expect((await readdir(dir)).sort()).toEqual(['reviewer.md'])
  })

  it('利用者が同じ名前で置いたファイルは上書きしない', async () => {
    const dir = join(root, '.claude', 'agents')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ferret-shop.md'), 'mine')
    const result = await syncOrchestrator(root, [])
    expect(result.skipped).toEqual(['ferret-shop.md'])
    expect(await readFile(join(dir, 'ferret-shop.md'), 'utf8')).toBe('mine')
  })

  it.skipIf(process.platform === 'win32')('.claude がリンクなら書かない', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'ferret-orch-elsewhere-'))
    try {
      await symlink(elsewhere, join(root, '.claude'))
      await expect(syncOrchestrator(root, [])).rejects.toThrow(/symbolic link/)
      expect(await readdir(elsewhere)).toEqual([])
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})
