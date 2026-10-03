import { describe, expect, it } from 'vitest'
import {
  addShape,
  canGrabShape,
  canRedoShapes,
  canUndoShapes,
  clearShapes,
  emptyShapes,
  grabShapeAt,
  moveShape,
  redoShapes,
  shapeBounds,
  undoShapes,
  type Shape
} from '../../src/shared/annotationShapes'
import { annotationKeyAction, annotationModeForTool, nextAnnotationColor, type AnnotationKeyInput } from '../../src/shared/annotation'

const rect = (key: number, id: string, box: [number, number, number, number]): Shape => ({ key, id, color: 'rose', kind: 'rect', rect: box })
const line = (key: number, id: string, points: Array<[number, number]>): Shape => ({ key, id, color: 'blue', kind: 'pen', points })

/** 呼ぶたびに n1, n2 … を返す（新しい記録の ID） */
function ids(): () => string {
  let n = 0
  return () => `n${++n}`
}

describe('書き込みの一覧（描く・動かす）', () => {
  it('描いた形を足し、記録へ draw を送る', () => {
    const r = addShape(emptyShapes(), rect(1, 'p1', [10, 10, 100, 50]))
    expect(r.state.shapes.map((s) => s.id)).toEqual(['p1'])
    expect(r.records).toEqual([{ type: 'draw', shape: rect(1, 'p1', [10, 10, 100, 50]) }])
    expect(canUndoShapes(r.state)).toBe(true)
    expect(canRedoShapes(r.state)).toBe(false)
  })

  it('動かすと新しい ID になり、前の ID を replaces で指す（操作ログは追記のみ）', () => {
    const drawn = addShape(emptyShapes(), line(1, 'p1', [[0, 0], [10, 10]])).state
    const moved = moveShape(drawn, 1, 5, -2, 'p2')!
    expect(moved.state.shapes).toEqual([line(1, 'p2', [[5, -2], [15, 8]])])
    expect(moved.records).toEqual([{ type: 'draw', shape: line(1, 'p2', [[5, -2], [15, 8]]), replaces: 'p1' }])
  })

  it('動いていなければ1手にしない', () => {
    const drawn = addShape(emptyShapes(), rect(1, 'p1', [0, 0, 10, 10])).state
    expect(moveShape(drawn, 1, 0, 0, 'p2')).toBeNull()
    expect(moveShape(drawn, 9, 3, 3, 'p2')).toBeNull()
  })

  it('囲む枠は線の点の範囲、四角はそのまま', () => {
    expect(shapeBounds(line(1, 'p1', [[30, 40], [10, 90], [50, 60]]))).toEqual([10, 40, 40, 50])
    expect(shapeBounds(rect(1, 'p1', [1, 2, 3, 4]))).toEqual([1, 2, 3, 4])
  })
})

describe('つかめる判定', () => {
  const box = rect(1, 'p1', [100, 100, 200, 100])

  it('四角は枠の線の近くだけつかめ、内側の空いたところはつかめない', () => {
    expect(canGrabShape(box, 100, 150, 6)).toBe(true)
    expect(canGrabShape(box, 95, 150, 6)).toBe(true)
    expect(canGrabShape(box, 200, 204, 6)).toBe(true)
    expect(canGrabShape(box, 200, 150, 6)).toBe(false)
    expect(canGrabShape(box, 80, 150, 6)).toBe(false)
  })

  it('線はその線の近くだけつかめる', () => {
    const stroke = line(1, 'p1', [[0, 0], [100, 0], [100, 100]])
    expect(canGrabShape(stroke, 50, 4, 6)).toBe(true)
    expect(canGrabShape(stroke, 104, 50, 6)).toBe(true)
    expect(canGrabShape(stroke, 50, 50, 6)).toBe(false)
    expect(canGrabShape(line(2, 'p2', [[10, 10]]), 12, 12, 6)).toBe(true)
  })

  it('重なっていたら後から描いた（上の）形をつかむ', () => {
    let state = addShape(emptyShapes(), rect(1, 'p1', [0, 0, 100, 100])).state
    state = addShape(state, rect(2, 'p2', [0, 0, 50, 50])).state
    expect(grabShapeAt(state, 0, 25, 6)?.key).toBe(2)
    expect(grabShapeAt(state, 100, 80, 6)?.key).toBe(1)
    expect(grabShapeAt(state, 75, 75, 6)).toBeUndefined()
  })
})

describe('元に戻す・やり直す', () => {
  it('描いたことを戻すと画面から消え、記録へ erase を送る。やり直すと新しい ID で描き直す', () => {
    const next = ids()
    const drawn = addShape(emptyShapes(), rect(1, 'p1', [0, 0, 10, 10])).state
    const undone = undoShapes(drawn, next)!
    expect(undone.state.shapes).toEqual([])
    expect(undone.records).toEqual([{ type: 'erase', ids: ['p1'] }])
    expect(canRedoShapes(undone.state)).toBe(true)

    const redone = redoShapes(undone.state, next)!
    expect(redone.state.shapes).toEqual([rect(1, 'n1', [0, 0, 10, 10])])
    expect(redone.records).toEqual([{ type: 'draw', shape: rect(1, 'n1', [0, 0, 10, 10]) }])
    expect(canRedoShapes(redone.state)).toBe(false)
  })

  it('動かしたことを戻すと前の位置へ。記録には前の位置の形を、今の ID を置き換えるものとして送る', () => {
    const next = ids()
    let state = addShape(emptyShapes(), rect(1, 'p1', [0, 0, 10, 10])).state
    state = moveShape(state, 1, 20, 0, 'p2')!.state
    const undone = undoShapes(state, next)!
    expect(undone.state.shapes).toEqual([rect(1, 'n1', [0, 0, 10, 10])])
    expect(undone.records).toEqual([{ type: 'draw', shape: rect(1, 'n1', [0, 0, 10, 10]), replaces: 'p2' }])

    const redone = redoShapes(undone.state, next)!
    expect(redone.state.shapes).toEqual([rect(1, 'n2', [20, 0, 10, 10])])
    expect(redone.records).toEqual([{ type: 'draw', shape: rect(1, 'n2', [20, 0, 10, 10]), replaces: 'n1' }])
  })

  it('動かした後に描いたことまで戻すと、今の ID（動かした後の ID）を erase する', () => {
    const next = ids()
    let state = addShape(emptyShapes(), rect(1, 'p1', [0, 0, 10, 10])).state
    state = moveShape(state, 1, 5, 5, 'p2')!.state
    state = undoShapes(state, next)!.state
    const undone = undoShapes(state, next)!
    expect(undone.records).toEqual([{ type: 'erase', ids: ['n1'] }])
    expect(canUndoShapes(undone.state)).toBe(false)
  })

  it('［消去］は1手。記録には何も送らず、戻すと画面に戻る', () => {
    const next = ids()
    let state = addShape(emptyShapes(), rect(1, 'p1', [0, 0, 10, 10])).state
    state = addShape(state, line(2, 'p2', [[0, 0], [5, 5]])).state
    const cleared = clearShapes(state)
    expect(cleared.state.shapes).toEqual([])
    expect(cleared.records).toEqual([])
    const undone = undoShapes(cleared.state, next)!
    expect(undone.state.shapes.map((s) => s.id)).toEqual(['p1', 'p2'])
    expect(undone.records).toEqual([])
    const redone = redoShapes(undone.state, next)!
    expect(redone.state.shapes).toEqual([])
    expect(redone.records).toEqual([])
  })

  it('何も無いときの［消去］は1手にしない', () => {
    expect(canUndoShapes(clearShapes(emptyShapes()).state)).toBe(false)
  })

  it('新しく描くと、やり直しの手順は消える', () => {
    const next = ids()
    let state = addShape(emptyShapes(), rect(1, 'p1', [0, 0, 10, 10])).state
    state = undoShapes(state, next)!.state
    state = addShape(state, rect(2, 'p2', [0, 0, 20, 20])).state
    expect(canRedoShapes(state)).toBe(false)
    expect(redoShapes(state, next)).toBeNull()
  })

  it('戻すものが無ければ null', () => {
    expect(undoShapes(emptyShapes(), ids())).toBeNull()
    expect(redoShapes(emptyShapes(), ids())).toBeNull()
  })
})

describe('書き込みのショートカット', () => {
  const key = (k: string, mods: Partial<AnnotationKeyInput> = {}): AnnotationKeyInput =>
    ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

  it('P でペン、B か R で四角、V か Esc で書き込みなし、C で次の色', () => {
    expect(annotationKeyAction(key('p'), true)).toBe('pen')
    expect(annotationKeyAction(key('P'), true)).toBe('pen')
    expect(annotationKeyAction(key('b'), false)).toBe('rect')
    expect(annotationKeyAction(key('r'), false)).toBe('rect')
    expect(annotationKeyAction(key('v'), true)).toBe('off')
    expect(annotationKeyAction(key('Escape'), true)).toBe('off')
    expect(annotationKeyAction(key('c'), true)).toBe('color')
  })

  it('macOS は ⌘Z / ⌘⇧Z、それ以外は Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y', () => {
    expect(annotationKeyAction(key('z', { metaKey: true }), true)).toBe('undo')
    expect(annotationKeyAction(key('Z', { metaKey: true, shiftKey: true }), true)).toBe('redo')
    expect(annotationKeyAction(key('z', { ctrlKey: true }), true)).toBeNull()
    expect(annotationKeyAction(key('z', { ctrlKey: true }), false)).toBe('undo')
    expect(annotationKeyAction(key('z', { ctrlKey: true, shiftKey: true }), false)).toBe('redo')
    expect(annotationKeyAction(key('y', { ctrlKey: true }), false)).toBe('redo')
    expect(annotationKeyAction(key('y', { metaKey: true }), true)).toBeNull()
  })

  it('修飾キー付きの文字（⌘P・Ctrl+C・Shift+P）や他のキーは奪わない', () => {
    expect(annotationKeyAction(key('p', { metaKey: true }), true)).toBeNull()
    expect(annotationKeyAction(key('c', { ctrlKey: true }), false)).toBeNull()
    expect(annotationKeyAction(key('P', { shiftKey: true }), true)).toBeNull()
    expect(annotationKeyAction(key('Alt', { altKey: true }), true)).toBeNull()
    expect(annotationKeyAction(key('a'), true)).toBeNull()
  })

  it('矢印（ブラウザを操作）を選ぶと mode が off になり、ページを素通しで操作できる', () => {
    expect(annotationModeForTool('none')).toBe('off')
    expect(annotationModeForTool('pen')).toBe('pen')
    expect(annotationModeForTool('rect')).toBe('rect')
  })

  it('色は候補を順に回り、最後の次は最初に戻る', () => {
    expect(nextAnnotationColor('rose')).toBe('red')
    expect(nextAnnotationColor('black')).toBe('rose')
  })
})
