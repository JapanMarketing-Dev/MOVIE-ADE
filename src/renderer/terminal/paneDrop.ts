import { hasLeaf, insertAtLeaf, insertAtRoot, leaf, leafIds, moveLeaf, neighborLeaf, removeLeaf, type PaneEdge, type PaneDropZone, type PaneNode } from './paneTree'

/**
 * ターミナルのタブ・ペインのドラッグ＆ドロップの結果を計算する（純粋関数。TerminalPane と単体テストから使う）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/tab-group/tab-drag-drop-commit.ts（落とした先ごとの確定）,
 *           ~/bench/orca/src/renderer/src/components/tab-group/useTabDragSplit.ts（タブをペインの辺に落とすと分割）,
 *           ~/bench/orca/src/renderer/src/lib/pane-manager/pane-drag-reorder.ts（ペインの並べ替え）（MIT, Copyright 2026 Lovecast Inc.）
 *
 * ここではタブが分割の木（ペイン＝PTY）を持つ。Orca はグループがタブを持つので、次のように読み替えた。
 * - 辺に落とす → 対象のペインをその向きに分割して置く（タブごと落とせば、そのタブの分割の形のまま入る）
 * - 中央に落とす → タブとして置く（ペインなら分割から外して新しいタブに、タブなら対象のタブの隣へ）
 * - タブ列に落とす → その位置のタブとして置く
 * - 動かした結果、空になったタブは閉じる
 * ペインのキーは変えない（キーに PTY が結びついているので、動かしても作り直さない）。
 */

export interface DropTab {
  key: string
  projectId: string | null
  layout: PaneNode
  activePane: string
}

export type TerminalDragSource = { kind: 'tab'; tabKey: string } | { kind: 'pane'; tabKey: string; paneKey: string }

export type TerminalDropTarget =
  /** 表示中のタブのペインの上 */
  | { kind: 'pane'; tabKey: string; paneKey: string; zone: PaneDropZone }
  /** 表示中のタブの領域全体の辺（いちばん外側で分割） */
  | { kind: 'root'; tabKey: string; edge: PaneEdge }
  /** タブ列。beforeTabKey の前に置く（null なら最後） */
  | { kind: 'tabbar'; beforeTabKey: string | null }

export interface DropResult<T extends DropTab> {
  tabs: T[]
  /** 選択するタブとフォーカスするペイン */
  activeTab: string
  activePane: string
}

/** ペインを木から外す。最後の1枚なら null（タブを閉じる） */
function detachPane<T extends DropTab>(tab: T, paneKey: string): T | null {
  const layout = removeLeaf(tab.layout, paneKey)
  if (!layout) return null
  const activePane = tab.activePane === paneKey ? (neighborLeaf(tab.layout, paneKey) ?? leafIds(layout)[0]!) : tab.activePane
  return { ...tab, layout, activePane }
}

/** tab を、並びの中で beforeKey の前（null なら最後）に置き直す */
function placeTab<T extends DropTab>(tabs: readonly T[], tab: T, beforeKey: string | null): T[] {
  const rest = tabs.filter((t) => t.key !== tab.key)
  const index = beforeKey === null ? -1 : rest.findIndex((t) => t.key === beforeKey)
  return index < 0 ? [...rest, tab] : [...rest.slice(0, index), tab, ...rest.slice(index)]
}

/** 並びの中で key の次にあるタブのキー（無ければ null＝最後） */
function keyAfter(tabs: readonly DropTab[], key: string): string | null {
  const index = tabs.findIndex((t) => t.key === key)
  return index < 0 ? null : (tabs[index + 1]?.key ?? null)
}

/**
 * 落とした結果。何も変わらない（自分の上に落とした等）・落とせない（別のプロジェクト等）なら null。
 * newTab は、ペインを分割から外して新しいタブにするときのタブの形を作る（キーと projectId を決める）
 */
export function applyTerminalDrop<T extends DropTab>(
  tabs: readonly T[],
  source: TerminalDragSource,
  target: TerminalDropTarget,
  newTab: (projectId: string | null, paneKey: string) => T
): DropResult<T> | null {
  const sourceTab = tabs.find((t) => t.key === source.tabKey)
  if (!sourceTab) return null
  if (source.kind === 'pane' && !hasLeaf(sourceTab.layout, source.paneKey)) return null
  const targetTab = target.kind === 'tabbar' ? null : tabs.find((t) => t.key === target.tabKey)
  if (target.kind !== 'tabbar') {
    // 別のプロジェクトのタブへは動かさない（カレントのフォルダが違う）
    if (!targetTab || (targetTab.projectId ?? '') !== (sourceTab.projectId ?? '')) return null
    if (target.kind === 'pane' && !hasLeaf(targetTab.layout, target.paneKey)) return null
  }
  // タブ列の並びは全プロジェクトで1列（表示はプロジェクトごとに絞る）。beforeTabKey が別のプロジェクトのタブでも、
  // 表示中のタブ同士の順は正しくなる

  // タブとして置く（タブ列・中央）
  const asTab = target.kind === 'tabbar' || (target.kind === 'pane' && target.zone === 'center')
  if (asTab) {
    const before = target.kind === 'tabbar' ? target.beforeTabKey : keyAfter(tabs, target.tabKey)
    if (source.kind === 'tab') {
      if (target.kind === 'pane' && target.tabKey === sourceTab.key) return null
      const next = placeTab(tabs, sourceTab, before === sourceTab.key ? keyAfter(tabs, sourceTab.key) : before)
      if (next.every((t, i) => t === tabs[i])) return null
      return { tabs: next, activeTab: sourceTab.key, activePane: sourceTab.activePane }
    }
    // ペインが1枚だけのタブなら、タブを並べ替えるのと同じ
    const rest = detachPane(sourceTab, source.paneKey)
    if (!rest) {
      if (target.kind === 'pane') return null
      return applyTerminalDrop(tabs, { kind: 'tab', tabKey: sourceTab.key }, target, newTab)
    }
    const created = newTab(sourceTab.projectId, source.paneKey)
    const replaced = tabs.map((t) => (t.key === sourceTab.key ? rest : t))
    return { tabs: placeTab([...replaced, created], created, before), activeTab: created.key, activePane: source.paneKey }
  }

  // 分割して置く（ペインの辺・領域全体の辺）
  const into = targetTab!
  if (source.kind === 'tab') {
    if (sourceTab.key === into.key) return null
    const layout =
      target.kind === 'root'
        ? insertAtRoot(into.layout, target.edge, sourceTab.layout)
        : insertAtLeaf(into.layout, target.paneKey, target.zone as PaneEdge, sourceTab.layout)
    const merged = { ...into, layout, activePane: sourceTab.activePane }
    return {
      tabs: tabs.filter((t) => t.key !== sourceTab.key).map((t) => (t.key === into.key ? merged : t)),
      activeTab: into.key,
      activePane: sourceTab.activePane
    }
  }

  const paneKey = source.paneKey
  if (sourceTab.key === into.key) {
    const layout =
      target.kind === 'root'
        ? leafIds(into.layout).length < 2
          ? into.layout
          : insertAtRoot(removeLeaf(into.layout, paneKey)!, target.edge, leaf(paneKey))
        : moveLeaf(into.layout, paneKey, target.paneKey, target.zone as PaneEdge)
    if (JSON.stringify(layout) === JSON.stringify(into.layout)) return null
    return {
      tabs: tabs.map((t) => (t.key === into.key ? { ...t, layout, activePane: paneKey } : t)),
      activeTab: into.key,
      activePane: paneKey
    }
  }
  const rest = detachPane(sourceTab, paneKey)
  const layout =
    target.kind === 'root'
      ? insertAtRoot(into.layout, target.edge, leaf(paneKey))
      : insertAtLeaf(into.layout, target.paneKey, target.zone as PaneEdge, leaf(paneKey))
  const next = tabs.flatMap((t) => {
    if (t.key === sourceTab.key) return rest ? [rest] : []
    if (t.key === into.key) return [{ ...t, layout, activePane: paneKey }]
    return [t]
  })
  return { tabs: next, activeTab: into.key, activePane: paneKey }
}
