/**
 * ターミナルのタブ・ペインのドラッグ＆ドロップ（落とす位置の判定と、分割の木・タブの並びの組み替え）。
 * ペインのキー（＝PTY の結びつき）が変わらないこと、読み込み直し用の記録に結果が残ることも見る。
 */
import { describe, expect, it } from 'vitest'
import { applyTerminalDrop, type DropTab } from '../../src/renderer/terminal/paneDrop'
import {
  insertAtLeaf,
  insertAtRoot,
  leaf,
  leafIds,
  moveLeaf,
  resolvePaneDropZone,
  resolveRootEdge,
  type PaneNode
} from '../../src/renderer/terminal/paneTree'
import { buildTerminalSnapshot, parseTerminalSnapshot, planTerminalRestore } from '../../src/renderer/terminal/restorePlan'

const split = (direction: 'vertical' | 'horizontal', first: PaneNode, second: PaneNode): PaneNode => ({
  type: 'split',
  direction,
  first,
  second,
  ratio: 0.5
})

describe('落とす位置', () => {
  const rect = { left: 100, top: 100, width: 400, height: 200 }

  it('辺の帯（25%）ならいちばん近い辺、内側は中央', () => {
    expect(resolvePaneDropZone(rect, { x: 110, y: 200 })).toBe('left')
    expect(resolvePaneDropZone(rect, { x: 490, y: 200 })).toBe('right')
    expect(resolvePaneDropZone(rect, { x: 300, y: 105 })).toBe('top')
    expect(resolvePaneDropZone(rect, { x: 300, y: 295 })).toBe('bottom')
    expect(resolvePaneDropZone(rect, { x: 300, y: 200 })).toBe('center')
  })

  it('領域全体の外周の帯だけが「いちばん外側で分割」。外や内側は null', () => {
    expect(resolveRootEdge(rect, { x: 105, y: 200 })).toBe('left')
    expect(resolveRootEdge(rect, { x: 300, y: 296 })).toBe('bottom')
    expect(resolveRootEdge(rect, { x: 300, y: 200 })).toBeNull()
    expect(resolveRootEdge(rect, { x: 50, y: 200 })).toBeNull()
  })
})

describe('分割の木の組み替え', () => {
  it('辺に置く: 左・上は前に、右・下は後ろに、向きは左右なら vertical', () => {
    expect(insertAtLeaf(leaf('a'), 'a', 'left', leaf('b'))).toEqual(split('vertical', leaf('b'), leaf('a')))
    expect(insertAtLeaf(leaf('a'), 'a', 'bottom', leaf('b'))).toEqual(split('horizontal', leaf('a'), leaf('b')))
    // 入れ子の葉にも、分割の木ごとにも置ける
    const root = split('vertical', leaf('a'), leaf('b'))
    expect(leafIds(insertAtLeaf(root, 'b', 'top', split('vertical', leaf('c'), leaf('d'))))).toEqual(['a', 'c', 'd', 'b'])
  })

  it('いちばん外側で分割する', () => {
    const root = split('vertical', leaf('a'), leaf('b'))
    expect(insertAtRoot(root, 'bottom', leaf('c'))).toEqual(split('horizontal', root, leaf('c')))
  })

  it('同じ木の中で動かす（外してから対象の隣へ）。自分に落とせば変わらない', () => {
    const root = split('vertical', leaf('a'), split('horizontal', leaf('b'), leaf('c')))
    expect(moveLeaf(root, 'a', 'c', 'bottom')).toEqual(split('horizontal', leaf('b'), split('horizontal', leaf('c'), leaf('a'))))
    expect(moveLeaf(root, 'a', 'a', 'left')).toBe(root)
    expect(moveLeaf(root, 'x', 'a', 'left')).toBe(root)
  })
})

describe('applyTerminalDrop', () => {
  const tab = (key: string, layout: PaneNode, projectId: string | null = 'p1'): DropTab => ({
    key,
    projectId,
    layout,
    activePane: leafIds(layout)[0]!
  })
  let seq = 0
  const newTab = (projectId: string | null, paneKey: string): DropTab => ({ key: `new${++seq}`, projectId, layout: leaf(paneKey), activePane: paneKey })

  it('タブをペインの辺に落とすと、そのペインを分割して入り、元のタブは閉じる', () => {
    const tabs = [tab('t1', leaf('a')), tab('t2', leaf('b'))]
    const result = applyTerminalDrop(tabs, { kind: 'tab', tabKey: 't2' }, { kind: 'pane', tabKey: 't1', paneKey: 'a', zone: 'right' }, newTab)
    expect(result?.tabs).toEqual([{ key: 't1', projectId: 'p1', layout: split('vertical', leaf('a'), leaf('b')), activePane: 'b' }])
    expect(result).toMatchObject({ activeTab: 't1', activePane: 'b' })
  })

  it('分割したタブを落とすと、その形のまま入る。領域全体の辺ならいちばん外側で分割', () => {
    const t1 = tab('t1', split('vertical', leaf('a'), leaf('b')))
    const t2 = tab('t2', split('horizontal', leaf('c'), leaf('d')))
    const result = applyTerminalDrop([t1, t2], { kind: 'tab', tabKey: 't2' }, { kind: 'root', tabKey: 't1', edge: 'top' }, newTab)
    expect(result?.tabs[0]?.layout).toEqual(split('horizontal', t2.layout, t1.layout))
    expect(result?.tabs).toHaveLength(1)
  })

  it('ペインを中央に落とすと、分割から外して隣の新しいタブにする（PTY のキーはそのまま）', () => {
    const t1 = tab('t1', split('vertical', leaf('a'), leaf('b')))
    const t2 = tab('t2', leaf('c'))
    const result = applyTerminalDrop([t1, t2], { kind: 'pane', tabKey: 't1', paneKey: 'b' }, { kind: 'pane', tabKey: 't1', paneKey: 'a', zone: 'center' }, newTab)!
    expect(result.tabs.map((t) => t.key)).toEqual(['t1', expect.stringMatching(/^new/), 't2'])
    expect(result.tabs[0]?.layout).toEqual(leaf('a'))
    expect(result.tabs[1]?.layout).toEqual(leaf('b'))
    expect(result.activePane).toBe('b')
  })

  it('ペインを別のタブのペインの辺へ動かす。最後の1枚を動かした元のタブは閉じる', () => {
    const t1 = tab('t1', split('vertical', leaf('a'), leaf('b')))
    const t2 = tab('t2', leaf('c'))
    const moved = applyTerminalDrop([t1, t2], { kind: 'pane', tabKey: 't1', paneKey: 'b' }, { kind: 'pane', tabKey: 't2', paneKey: 'c', zone: 'left' }, newTab)!
    expect(moved.tabs).toEqual([
      { key: 't1', projectId: 'p1', layout: leaf('a'), activePane: 'a' },
      { key: 't2', projectId: 'p1', layout: split('vertical', leaf('b'), leaf('c')), activePane: 'b' }
    ])
    const emptied = applyTerminalDrop(moved.tabs, { kind: 'pane', tabKey: 't1', paneKey: 'a' }, { kind: 'pane', tabKey: 't2', paneKey: 'c', zone: 'bottom' }, newTab)!
    expect(emptied.tabs.map((t) => t.key)).toEqual(['t2'])
    expect(leafIds(emptied.tabs[0]!.layout).sort()).toEqual(['a', 'b', 'c'])
  })

  it('同じタブの中で並べ替える', () => {
    const t1 = tab('t1', split('vertical', leaf('a'), leaf('b')))
    const result = applyTerminalDrop([t1], { kind: 'pane', tabKey: 't1', paneKey: 'a' }, { kind: 'pane', tabKey: 't1', paneKey: 'b', zone: 'right' }, newTab)
    expect(result?.tabs[0]?.layout).toEqual(split('vertical', leaf('b'), leaf('a')))
  })

  it('タブ列に落とすと並べ替え。ペインならその位置の新しいタブになる', () => {
    const tabs = [tab('t1', leaf('a')), tab('t2', split('vertical', leaf('b'), leaf('c'))), tab('t3', leaf('d'))]
    expect(applyTerminalDrop(tabs, { kind: 'tab', tabKey: 't3' }, { kind: 'tabbar', beforeTabKey: 't1' }, newTab)?.tabs.map((t) => t.key)).toEqual(['t3', 't1', 't2'])
    const torn = applyTerminalDrop(tabs, { kind: 'pane', tabKey: 't2', paneKey: 'c' }, { kind: 'tabbar', beforeTabKey: null }, newTab)!
    expect(torn.tabs.map((t) => leafIds(t.layout))).toEqual([['a'], ['b'], ['d'], ['c']])
  })

  it('何も変わらない・落とせないときは null（自分の上、同じ位置、別のプロジェクト）', () => {
    const tabs = [tab('t1', leaf('a')), tab('t2', leaf('b')), tab('t3', leaf('c'), 'p2')]
    expect(applyTerminalDrop(tabs, { kind: 'tab', tabKey: 't1' }, { kind: 'pane', tabKey: 't1', paneKey: 'a', zone: 'right' }, newTab)).toBeNull()
    expect(applyTerminalDrop(tabs, { kind: 'tab', tabKey: 't1' }, { kind: 'tabbar', beforeTabKey: 't2' }, newTab)).toBeNull()
    expect(applyTerminalDrop(tabs, { kind: 'tab', tabKey: 't3' }, { kind: 'pane', tabKey: 't1', paneKey: 'a', zone: 'left' }, newTab)).toBeNull()
    expect(applyTerminalDrop(tabs, { kind: 'tab', tabKey: 'gone' }, { kind: 'tabbar', beforeTabKey: null }, newTab)).toBeNull()
  })

  it('組み替えた結果を読み込み直し用の記録に書くと、同じ形・同じ PTY で戻る', () => {
    const tabs = [tab('t1', leaf('a')), tab('t2', leaf('b'))]
    const result = applyTerminalDrop(tabs, { kind: 'tab', tabKey: 't2' }, { kind: 'pane', tabKey: 't1', paneKey: 'a', zone: 'bottom' }, newTab)!
    const ptyIds: Record<string, string> = { a: 'pty-1', b: 'pty-2' }
    const snapshot = buildTerminalSnapshot({
      tabs: result.tabs,
      panes: [
        { key: 'a', title: '1: zsh', launch: null, cwd: '/p1' },
        { key: 'b', title: '2: zsh', launch: null, cwd: '/p1' }
      ],
      ptyIdOf: (key) => ptyIds[key] ?? null,
      activeByProject: { p1: result.activeTab }
    })
    const plan = planTerminalRestore({
      snapshot: parseTerminalSnapshot(JSON.stringify(snapshot)),
      live: [
        { id: 'pty-1', title: '1: zsh', cwd: '/p1', agent: null },
        { id: 'pty-2', title: '2: zsh', cwd: '/p1', agent: null }
      ] as never,
      projects: [{ id: 'p1', folderPath: '/p1' }],
      newKey: (kind) => `${kind}-new`
    })
    expect(plan.tabs).toEqual([{ key: 't1', projectId: 'p1', layout: split('horizontal', leaf('a'), leaf('b')), activePane: 'b' }])
    expect(plan.panes.map((p) => [p.key, p.ptyId])).toEqual([['a', 'pty-1'], ['b', 'pty-2']])
    expect(plan.close).toEqual([])
  })
})
