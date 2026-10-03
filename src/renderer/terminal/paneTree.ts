/**
 * タブの中のペイン分割（純粋関数だけ。TerminalPane と単体テストから使う）。
 *
 * Orca由来: ~/bench/orca/src/shared/terminal-tab-types.ts（TerminalPaneLayoutNode）,
 *           ~/bench/orca/src/renderer/src/lib/pane-manager/pane-tree-ops.ts,
 *           ~/bench/orca/src/renderer/src/lib/pane-manager/pane-divider-drag.ts（MIN_PANE_SIZE）,
 *           ~/bench/orca/src/shared/default-global-settings.ts,
 *           ~/bench/orca/src/shared/constants.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく、分割は二分木で表す。'vertical' は左右に並べる（右に分割）、
 * 'horizontal' は上下に並べる（下に分割）。ratio は1つ目の子の割合（0〜1）。
 * Orca は DOM を直接組み替えるが、ここでは木を React で描くので、木の操作だけを抜き出した。
 */

export type PaneSplitDirection = 'vertical' | 'horizontal'

export type PaneNode =
  | { type: 'leaf'; leafId: string }
  | { type: 'split'; direction: PaneSplitDirection; first: PaneNode; second: PaneNode; ratio: number }

/** Orca の既定値: 非アクティブなペインの不透明度・アクティブ・区切り線の太さ */
export const INACTIVE_PANE_OPACITY = 0.9
export const ACTIVE_PANE_OPACITY = 1
export const DIVIDER_THICKNESS_PX = 3
/** 区切り線の掴める幅。見える線の両側に足す余白（Orca の HIT_PADDING） */
export const DIVIDER_HIT_PADDING_PX = 3
/** ドラッグで縮められる最小のペインの大きさ（px） */
export const MIN_PANE_SIZE_PX = 50

/** 子の位置。'' が根、'0' が根の first、'01' が根の first の second */
export type PanePath = string

export function leaf(leafId: string): PaneNode {
  return { type: 'leaf', leafId }
}

/** 左上から順に並べた葉の一覧 */
export function leafIds(node: PaneNode): string[] {
  return node.type === 'leaf' ? [node.leafId] : [...leafIds(node.first), ...leafIds(node.second)]
}

export function hasLeaf(node: PaneNode, leafId: string): boolean {
  return node.type === 'leaf' ? node.leafId === leafId : hasLeaf(node.first, leafId) || hasLeaf(node.second, leafId)
}

/** leafId のペインを分割し、新しいペインを右（または下）に置く */
export function splitLeaf(
  node: PaneNode,
  leafId: string,
  direction: PaneSplitDirection,
  newLeafId: string
): PaneNode {
  if (node.type === 'leaf') {
    if (node.leafId !== leafId) return node
    return { type: 'split', direction, first: node, second: leaf(newLeafId), ratio: 0.5 }
  }
  const first = splitLeaf(node.first, leafId, direction, newLeafId)
  const second = first === node.first ? splitLeaf(node.second, leafId, direction, newLeafId) : node.second
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/**
 * ペインを取り除く。残った兄弟が親の位置に繰り上がる（Orca と同じ）。
 * 最後の1枚を取り除くと null。
 */
export function removeLeaf(node: PaneNode, leafId: string): PaneNode | null {
  if (node.type === 'leaf') return node.leafId === leafId ? null : node
  const first = removeLeaf(node.first, leafId)
  const second = removeLeaf(node.second, leafId)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** path の位置の分割の比率を変える */
export function setRatio(node: PaneNode, path: PanePath, ratio: number): PaneNode {
  if (node.type === 'leaf') return node
  if (path === '') return node.ratio === ratio ? node : { ...node, ratio }
  const [head, rest] = [path[0], path.slice(1)]
  return head === '0'
    ? { ...node, first: setRatio(node.first, rest, ratio) }
    : { ...node, second: setRatio(node.second, rest, ratio) }
}

/** 区切り線のドラッグ位置から比率を出す。どちらの側も最小の大きさより小さくしない */
export function ratioFromDrag(offset: number, total: number, minSize = MIN_PANE_SIZE_PX): number {
  if (!Number.isFinite(total) || total <= 0) return 0.5
  const min = Math.min(minSize, total / 2)
  return Math.max(min, Math.min(total - min, offset)) / total
}

/**
 * 取り除いたあとに焦点を移すペイン。閉じたペインの直前（なければ直後）。
 */
export function neighborLeaf(node: PaneNode, leafId: string): string | null {
  const ids = leafIds(node)
  const index = ids.indexOf(leafId)
  if (index < 0) return ids[0] ?? null
  return ids[index - 1] ?? ids[index + 1] ?? null
}
