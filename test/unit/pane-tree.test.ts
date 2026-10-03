/**
 * ターミナルのペイン分割の木（Orca由来の TerminalPaneLayoutNode の操作）。
 */
import { describe, expect, it } from 'vitest'
import {
  hasLeaf,
  leaf,
  leafIds,
  neighborLeaf,
  ratioFromDrag,
  removeLeaf,
  setRatio,
  splitLeaf,
  type PaneNode
} from '../../src/renderer/terminal/paneTree'

describe('splitLeaf', () => {
  it('葉を分割し、新しいペインを2つ目（右・下）に置く', () => {
    expect(splitLeaf(leaf('a'), 'a', 'vertical', 'b')).toEqual({
      type: 'split',
      direction: 'vertical',
      first: leaf('a'),
      second: leaf('b'),
      ratio: 0.5
    })
  })

  it('入れ子に分割でき、葉の順は左上から', () => {
    let root: PaneNode = leaf('a')
    root = splitLeaf(root, 'a', 'vertical', 'b')
    root = splitLeaf(root, 'a', 'horizontal', 'c')
    root = splitLeaf(root, 'b', 'horizontal', 'd')
    expect(leafIds(root)).toEqual(['a', 'c', 'b', 'd'])
    expect(hasLeaf(root, 'd')).toBe(true)
  })

  it('見つからなければ同じ木を返す', () => {
    const root = splitLeaf(leaf('a'), 'a', 'vertical', 'b')
    expect(splitLeaf(root, 'x', 'vertical', 'y')).toBe(root)
  })
})

describe('removeLeaf', () => {
  it('兄弟が親の位置に繰り上がる', () => {
    let root: PaneNode = splitLeaf(leaf('a'), 'a', 'vertical', 'b')
    root = splitLeaf(root, 'b', 'horizontal', 'c')
    const removed = removeLeaf(root, 'b')
    expect(removed).toEqual({ type: 'split', direction: 'vertical', first: leaf('a'), second: leaf('c'), ratio: 0.5 })
  })

  it('最後の1枚を取り除くと null', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull()
  })
})

describe('setRatio', () => {
  it('path の位置の分割だけ比率を変える', () => {
    let root: PaneNode = splitLeaf(leaf('a'), 'a', 'vertical', 'b')
    root = splitLeaf(root, 'b', 'horizontal', 'c')
    const next = setRatio(root, '1', 0.3)
    expect(next.type === 'split' && next.ratio).toBe(0.5)
    expect(next.type === 'split' && next.second.type === 'split' && next.second.ratio).toBe(0.3)
  })
})

describe('ratioFromDrag', () => {
  it('どちらの側も最小の大きさより小さくしない', () => {
    expect(ratioFromDrag(250, 500)).toBe(0.5)
    expect(ratioFromDrag(10, 500)).toBe(50 / 500)
    expect(ratioFromDrag(495, 500)).toBe(450 / 500)
    expect(ratioFromDrag(10, 0)).toBe(0.5)
  })
})

describe('neighborLeaf', () => {
  it('閉じたペインの直前、なければ直後へ移る', () => {
    let root: PaneNode = splitLeaf(leaf('a'), 'a', 'vertical', 'b')
    root = splitLeaf(root, 'b', 'vertical', 'c')
    expect(neighborLeaf(root, 'b')).toBe('a')
    expect(neighborLeaf(root, 'a')).toBe('b')
  })
})
