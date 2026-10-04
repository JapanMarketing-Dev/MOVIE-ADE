import { describe, expect, it } from 'vitest'
import {
  describeUnsavedFile,
  planUnsavedQuit,
  projectOfFile,
  quitActionFor,
  quitActions,
  sanitizeUnsavedRefs,
  screenQuitSaveEntries,
  type QuitProjectRef
} from '@shared/quitUnsaved'

const projects: QuitProjectRef[] = [
  { id: 'p-bid', name: '入札', folderPath: '/Users/taro/bid' },
  { id: 'p-reply', name: 'reply', folderPath: '/Users/taro/reply' },
  { id: 'p-nested', name: 'docs-site', folderPath: '/Users/taro/reply/site' }
]

const limits = { maxBytes: 10, maxTotalBytes: 15, byteLength: (s: string) => new TextEncoder().encode(s).length }

describe('終了の確認: どのプロジェクトのファイルか', () => {
  it('プロジェクト名とその中の相対パスで示す', () => {
    const item = describeUnsavedFile({ root: '/Users/taro/reply', path: 'docs/development.md' }, projects)
    expect(item).toMatchObject({ projectId: 'p-reply', projectName: 'reply', relativePath: 'docs/development.md', label: 'reply — docs/development.md' })
  })

  it('入れ子のプロジェクトは深いほうを選ぶ', () => {
    expect(projectOfFile('/Users/taro/reply/site/index.md', projects)?.project.id).toBe('p-nested')
  })

  it('名前の前方一致だけでは別のプロジェクトにしない（/Users/taro/reply2 は reply ではない）', () => {
    const item = describeUnsavedFile({ root: '/Users/taro/reply2', path: 'a.md' }, projects)
    expect(item.projectId).toBeNull()
    expect(item.label).toBe('/Users/taro/reply2/a.md')
  })

  it('Windows のパスは区切りと大文字小文字をそろえて比べる', () => {
    const win: QuitProjectRef[] = [{ id: 'w', name: 'app', folderPath: 'C:\\Users\\taro\\app\\' }]
    const item = describeUnsavedFile({ root: 'c:\\Users\\taro\\app', path: 'src/a.ts' }, win)
    expect(item.label).toBe('app — src/a.ts')
  })
})

describe('終了の確認: ボタンと一覧', () => {
  it('保存して終了が既定、Esc はキャンセル。プロジェクトに属すれば「プロジェクトを開く」も出す', () => {
    const plan = planUnsavedQuit([{ root: '/Users/taro/reply', path: 'docs/development.md' }], projects)
    expect(plan.actions).toEqual(['save', 'discard', 'openProject', 'cancel'])
    expect(plan.defaultId).toBe(0)
    expect(plan.actions[plan.cancelId]).toBe('cancel')
    expect(plan.openTarget?.projectId).toBe('p-reply')
  })

  it('どのプロジェクトにも属さなければ「プロジェクトを開く」を出さない', () => {
    const plan = planUnsavedQuit([{ root: '/Users/taro/elsewhere', path: 'a.md' }], projects)
    expect(plan.actions).toEqual(['save', 'discard', 'cancel'])
    expect(plan.cancelId).toBe(2)
    expect(plan.openTarget).toBeNull()
  })

  it('プロジェクトごとにまとめ、開くのは一覧の先頭のファイルのプロジェクト', () => {
    const plan = planUnsavedQuit([
      { root: '/Users/taro/elsewhere', path: 'x.md' },
      { root: '/Users/taro/reply', path: 'a.md' },
      { root: '/Users/taro/bid', path: 'b.md' },
      { root: '/Users/taro/reply', path: 'c.md' }
    ], projects)
    expect(plan.items.map((i) => i.label)).toEqual(['reply — a.md', 'reply — c.md', '入札 — b.md', '/Users/taro/elsewhere/x.md'])
    expect(plan.openTarget?.path).toBe('a.md')
  })

  it('上限を超えた分は数えて「ほか N 件」にする', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ root: '/Users/taro/reply', path: `f${i}.md` }))
    const plan = planUnsavedQuit(files, projects, 8)
    expect(plan.listed).toHaveLength(8)
    expect(plan.more).toBe(3)
  })

  it('押された番号から操作へ。範囲の外はキャンセル', () => {
    const actions = quitActions(true)
    expect(quitActionFor(0, actions)).toBe('save')
    expect(quitActionFor(1, actions)).toBe('discard')
    expect(quitActionFor(2, actions)).toBe('openProject')
    expect(quitActionFor(3, actions)).toBe('cancel')
    expect(quitActionFor(9, actions)).toBe('cancel')
    expect(quitActionFor(-1, quitActions(false))).toBe('cancel')
  })
})

describe('終了の確認: renderer から来たものを確かめる', () => {
  it('editor:unsaved は文字列の root と path だけを受ける', () => {
    expect(sanitizeUnsavedRefs([{ root: '/Users/taro/reply', path: 'a.md' }, 'x', { root: 1, path: 'b' }, { root: '/r', path: '' }, null])).toEqual([
      { root: '/Users/taro/reply', path: 'a.md' }
    ])
    expect(sanitizeUnsavedRefs('nope')).toEqual([])
  })

  it('確認で示したファイルだけを書く。示していないもの・大きすぎるもの・届かないものは分ける', () => {
    const expected = [
      { root: '/Users/taro/reply', path: 'a.md' },
      { root: '/Users/taro/bid', path: 'b.md' },
      { root: '/Users/taro/bid', path: 'c.md' }
    ]
    const screened = screenQuitSaveEntries([
      { root: '/Users/taro/reply', path: 'a.md', content: 'hello' },
      { root: '/Users/taro/reply', path: 'a.md', content: 'second' },
      { root: '/Users/taro/reply', path: '../../etc/passwd', content: 'x' },
      { root: '/Users/taro/bid', path: 'b.md', content: 'this is too long' },
      { root: '/Users/taro/bid', path: 'c.md', content: 42 }
    ], expected, limits)
    expect(screened.accepted).toEqual([{ root: '/Users/taro/reply', path: 'a.md', content: 'hello' }])
    expect(screened.rejected).toEqual([
      { root: '/Users/taro/reply', path: '../../etc/passwd', reason: 'unexpected' },
      { root: '/Users/taro/bid', path: 'b.md', reason: 'tooLarge' }
    ])
    expect(screened.missing).toEqual([{ root: '/Users/taro/bid', path: 'c.md' }])
  })

  it('全体の上限を超えた分は書かない', () => {
    const expected = [{ root: '/Users/taro/reply', path: 'a.md' }, { root: '/Users/taro/reply', path: 'b.md' }]
    const screened = screenQuitSaveEntries([
      { root: '/Users/taro/reply', path: 'a.md', content: '0123456789' },
      { root: '/Users/taro/reply', path: 'b.md', content: '0123456789' }
    ], expected, limits)
    expect(screened.accepted.map((e) => e.path)).toEqual(['a.md'])
    expect(screened.rejected).toEqual([{ root: '/Users/taro/reply', path: 'b.md', reason: 'tooLarge' }])
  })

  it('配列でなければ何も書かず、全部届かなかった扱い', () => {
    const expected = [{ root: '/Users/taro/reply', path: 'a.md' }]
    expect(screenQuitSaveEntries(null, expected, limits)).toEqual({ accepted: [], rejected: [], missing: expected })
  })
})
