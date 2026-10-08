/**
 * オーケストレーター：すぐ下のフォルダのプロジェクトを Claude Code の subagent にする（src/shared/orchestrator.ts・src/main/orchestrator.ts）
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GUIDE_END, GUIDE_START, SUBAGENT_MARKER, allOrchestratorChildren, childList, isFerretSubagent, orchestratorChildren, outsideFolders, planSubagents, renderOrchestratorGuide, renderSubagent, rulesTemplate, slug, withAdditionalDirectories, withGuideBlock, withoutGuideBlock } from '../../src/shared/orchestrator'
import { nestMembers } from '../../src/shared/projectOrder'
import type { Project } from '../../src/shared/types'
import { SubagentLinkError, syncOrchestrator } from '../../src/main/orchestrator'

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
      { dir: 'admin', path: '/w/admin', name: '管理画面', agent: 'ferret-admin' },
      { dir: 'shop', path: '/w/shop', name: 'shop', agent: 'ferret-shop' }
    ])
  })

  it('subagent の名前は英数字とハイフン。重なれば番号を付ける', () => {
    expect(slug('My Shop_v2')).toBe('my-shop-v2')
    expect(slug('管理')).toBe('project')
    const children = orchestratorChildren('/w', [{ name: '管理', isGitRepo: true }, { name: '販売', isGitRepo: true }], [], posix.join)
    expect(children.map((c) => c.agent)).toEqual(['ferret-project', 'ferret-project-2'])
  })

  it('subagent の中身：名前・説明・印・そのフォルダだけで作業する決まり', () => {
    const text = renderSubagent({ dir: 'shop', path: '/w/shop', name: 'Shop "EC"', agent: 'ferret-shop' })
    expect(text.startsWith('---\nname: ferret-shop\ndescription: "')).toBe(true)
    expect(text).toContain("Lead for the Shop 'EC' project (folder shop/)")
    expect(isFerretSubagent(text)).toBe(true)
    expect(text).toContain('`/w/shop`')
    expect(text).toContain('Do not edit files outside it')
    expect(text).toContain('Do not start a new connection or ask the user to approve again')
    expect(childList([{ dir: 'shop', path: '/w/shop', name: 'Shop', agent: 'ferret-shop' }])).toBe('Shop (shop/) → ferret-shop')
  })

  it('Windows：区切りと大文字・小文字が違っても登録済みのプロジェクトとして見る', () => {
    const children = orchestratorChildren('C:\\w', [{ name: 'admin', isGitRepo: false }], [{ folderPath: 'c:/W/Admin/', name: '管理画面' }], win32.join)
    expect(children).toEqual([{ dir: 'admin', path: 'C:\\w\\admin', name: '管理画面', agent: 'ferret-admin' }])
  })
})

describe('入れた既存のプロジェクト（フォルダはどこでもよい）', () => {
  const registered = [
    { id: 'p1', folderPath: '/code/abm-targeting', name: 'abm-targeting' },
    { id: 'p2', folderPath: '/code/shop', name: 'shop' },
    { id: 'p3', folderPath: '/remote', name: 'remote', source: 'ssh' },
    { id: 'p4', folderPath: '/w/shop', name: 'same-as-subfolder' }
  ]
  it('入れたものを絶対パスで足す。SSH・消えたもの・下のフォルダと同じもの・自分自身は入れない。subagent の名前は重ねない', () => {
    const sub = [{ dir: 'shop', path: '/w/shop', name: 'shop', agent: 'ferret-shop' }]
    const all = allOrchestratorChildren('/w', ['p1', 'p2', 'p3', 'p4', 'gone'], registered, sub)
    expect(all).toEqual([
      sub[0],
      { dir: '/code/abm-targeting', path: '/code/abm-targeting', outside: '/code/abm-targeting', projectId: 'p1', name: 'abm-targeting', agent: 'ferret-abm-targeting' },
      { dir: '/code/shop', path: '/code/shop', outside: '/code/shop', projectId: 'p2', name: 'shop', agent: 'ferret-shop-2' }
    ])
    expect(outsideFolders(all)).toEqual(['/code/abm-targeting', '/code/shop'])
  })

  it('Ferret の欄：子の一覧・共通と個別・並行・Chrome は上で1回。利用者の文は残し、欄だけ差し替える・外す', () => {
    const children = [{ dir: '/code/shop', path: '/code/shop', name: 'shop', agent: 'ferret-shop' }]
    const block = renderOrchestratorGuide(children)
    expect(block).toContain('`/code/shop` (subagent: `ferret-shop`)')
    expect(block).toMatch(/shared work and per-product work/)
    expect(block).toMatch(/run in parallel/)
    expect(block).toMatch(/Keep separate what must stay separate per product: infrastructure/)
    expect(block).toMatch(/set up once, here at the top: Claude in Chrome and other browser use, computer use/)
    const created = withGuideBlock(null, block, rulesTemplate(children, 'en'))!
    expect(created.startsWith(GUIDE_START)).toBe(true)
    expect(created).toContain('## Shared rules (all products)')
    expect(created).toContain('### shop')
    // リンクを作れたものは、メインフォルダの下のサブフォルダとして扱う
    const linked = allOrchestratorChildren('/w', ['p1'], [{ id: 'p1', folderPath: '/code/abm', name: 'abm' }], [], new Map([['p1', 'abm']]), posix.join)
    expect(linked).toEqual([{ dir: 'abm', path: '/w/abm', outside: '/code/abm', projectId: 'p1', name: 'abm', agent: 'ferret-abm' }])
    const userFile = `# My rules\n\nUse pnpm.\n`
    const merged = withGuideBlock(userFile, block)!
    expect(merged.startsWith('# My rules\n\nUse pnpm.\n\n' + GUIDE_START)).toBe(true)
    expect(withGuideBlock(merged, block)).toBeNull()
    const updated = withGuideBlock(merged, renderOrchestratorGuide([]))!
    expect(updated.split(GUIDE_START).length).toBe(2)
    expect(updated).toContain('no products yet')
    expect(withoutGuideBlock(updated)).toBe('# My rules\n\nUse pnpm.\n')
    expect(withoutGuideBlock(userFile)).toBeNull()
    expect(updated.indexOf(GUIDE_END)).toBeGreaterThan(0)
  })

  it('additionalDirectories：利用者の値は残し、Ferret が足した分だけ入れ替える。読めない JSON は触らない', () => {
    const user = JSON.stringify({ permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/mine'] }, model: 'x' })
    const first = withAdditionalDirectories(user, [], ['/code/a', '/code/b'])!
    expect(JSON.parse(first)).toEqual({ permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/mine', '/code/a', '/code/b'] }, model: 'x' })
    expect(withAdditionalDirectories(first, ['/code/a', '/code/b'], ['/code/a', '/code/b'])).toBeNull()
    const second = withAdditionalDirectories(first, ['/code/a', '/code/b'], ['/code/b'])!
    expect(JSON.parse(second).permissions.additionalDirectories).toEqual(['/mine', '/code/b'])
    const cleared = withAdditionalDirectories(withAdditionalDirectories(null, [], ['/code/a'])!, ['/code/a'], [])!
    expect(JSON.parse(cleared)).toEqual({})
    expect(withAdditionalDirectories('{broken', [], ['/code/a'])).toBeNull()
  })

  it('サイドバー：入れたプロジェクトはオーケストレーターのすぐ下に並ぶ。オーケストレーターが出ていなければ自分の位置', () => {
    const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/${id}`, urls: [], ...extra })
    const all = [p('a'), p('o', { orchestrator: true, members: ['c', 'a'] }), p('b'), p('c')]
    expect(nestMembers(all, all).map((x) => x.id)).toEqual(['o', 'a', 'c', 'b'])
    expect(nestMembers([all[0]!, all[2]!, all[3]!], all).map((x) => x.id)).toEqual(['a', 'b', 'c'])
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

  it('入れた既存のプロジェクトはメインフォルダの下のサブフォルダ（リンク）になり、subagent・additionalDirectories・CLAUDE.md / AGENTS.md / README.md に入る。外すとリンクだけ消す', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ferret-orch-member-'))
    try {
      await writeFile(join(outside, 'keep.txt'), 'keep')
      const registered = [{ id: 'm1', folderPath: outside, name: 'abm-targeting' }]
      const linkName = basename(outside)
      const on = await syncOrchestrator(root, registered, true, ['m1'], 'ja')
      expect(on.children.map((c) => c.agent)).toEqual(['ferret-admin', 'ferret-shop', 'ferret-abm-targeting'])
      expect((await lstat(join(root, linkName))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(root, linkName, 'keep.txt'), 'utf8')).toBe('keep')
      expect(await readFile(join(root, '.claude', 'agents', 'ferret-abm-targeting.md'), 'utf8')).toContain(join(root, linkName))
      expect(JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).permissions.additionalDirectories).toEqual([outside])
      const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
      expect(claude).toContain('(subagent: `ferret-abm-targeting`)')
      expect(claude).toContain('## 共通のルール（すべてのプロダクト）')
      expect(claude).toContain('### abm-targeting')
      expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('CLAUDE.md にあります')
      const readme = await readFile(join(root, 'README.md'), 'utf8')
      expect(readme.indexOf('# ')).toBe(0)
      expect(readme).toContain('**abm-targeting**')
      // 2回目は同じリンクを使い、増やさない
      await syncOrchestrator(root, registered, true, ['m1'], 'ja')
      expect((await readdir(root)).filter((n) => n.startsWith('ferret-orch-member-'))).toEqual([linkName])
      // 外すとリンクだけ消え、元のフォルダは残る。人が書いたルールは残る
      await syncOrchestrator(root, registered, true, [], 'ja')
      await expect(lstat(join(root, linkName))).rejects.toThrow()
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
      expect(JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'))).toEqual({})
      await syncOrchestrator(root, registered, false, [], 'ja')
      const after = await readFile(join(root, 'CLAUDE.md'), 'utf8')
      expect(after).not.toContain('ferret-orchestrator:start')
      expect(after).toContain('## 共通のルール（すべてのプロダクト）')
      expect(await readdir(join(root, '.claude', 'agents'))).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
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
      await expect(syncOrchestrator(root, [])).rejects.toThrow(SubagentLinkError)
      expect(await readdir(elsewhere)).toEqual([])
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})

import { editorFirst } from '../../src/shared/projectOrder'

describe('「すべてのプロジェクト」はサイドバーの一番上', () => {
  it('どの並びでも一番上。ほかの並びは保つ', () => {
    const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/${id}`, urls: [], ...extra })
    expect(editorFirst([p('a'), p('b'), p('all', { editorWorkspace: true, orchestrator: true }), p('c')]).map((x) => x.id)).toEqual(['all', 'a', 'b', 'c'])
  })
})
