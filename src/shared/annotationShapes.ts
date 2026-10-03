import type { AnnotationColor } from './annotation'

/**
 * 録画中の書き込み（手書きの線・四角の枠）を形のデータとして持つための純粋な処理。
 * 注入スクリプト（preload/review.ts）が使う。描き直し・つかんで動かす・元に戻す／やり直すは、すべてこの一覧から行う。
 *
 * 操作ログ（events.jsonl）は追記のみなので、一覧を変えたら「記録へ送るもの（ShapeRecord）」を返す:
 * - draw  … 新しい形、または動かした・戻した後の形。動かしたときは replaces に前の ID を入れる（ID は毎回新しくする）
 * - erase … 描いたことを元に戻した形の ID
 * 画面の［消去］は見た目を片付けるだけで、記録からは消さない（今までどおり）。元に戻すと画面に戻る。
 */

/** [x, y, w, h]（ビューの座標。CSS ピクセル） */
export type ShapeBox = [number, number, number, number]

interface ShapeBase {
  /** 画面の中だけの印。動かしても戻しても変わらない（元に戻す手順がこれで形を探す） */
  key: number
  /** 記録の ID（pen イベントの id）。動かす・戻すたびに新しくなる */
  id: string
  color: AnnotationColor
}

export type Shape = ShapeBase & ({ kind: 'pen'; points: Array<[number, number]> } | { kind: 'rect'; rect: ShapeBox })

/** 1手。描く・動かす・消去 */
export type ShapeStep =
  | { kind: 'add'; shape: Shape }
  | { kind: 'move'; key: number; from: Shape; to: Shape }
  | { kind: 'clear'; shapes: Shape[] }

export interface ShapeState {
  shapes: Shape[]
  undo: ShapeStep[]
  redo: ShapeStep[]
}

export type ShapeRecord = { type: 'draw'; shape: Shape; replaces?: string } | { type: 'erase'; ids: string[] }

export interface ShapeChange {
  state: ShapeState
  records: ShapeRecord[]
}

/** 元に戻せる手数の上限（録画中の長い操作でメモリを使い続けない） */
const MAX_STEPS = 100

export function emptyShapes(): ShapeState {
  return { shapes: [], undo: [], redo: [] }
}

export const canUndoShapes = (state: ShapeState): boolean => state.undo.length > 0
export const canRedoShapes = (state: ShapeState): boolean => state.redo.length > 0

/** 形を囲む枠 */
export function shapeBounds(shape: Shape): ShapeBox {
  if (shape.kind === 'rect') return [...shape.rect]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of shape.points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0]
  return [minX, minY, maxX - minX, maxY - minY]
}

/** 形を dx, dy だけずらしたもの（ID と印はそのまま） */
export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  if (shape.kind === 'rect') {
    const [x, y, w, h] = shape.rect
    return { ...shape, rect: [x + dx, y + dy, w, h] }
  }
  return { ...shape, points: shape.points.map(([x, y]) => [x + dx, y + dy]) }
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const length = vx * vx + vy * vy
  const ratio = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / length))
  return Math.hypot(px - (ax + ratio * vx), py - (ay + ratio * vy))
}

/** その点で、形をつかめるか。四角は枠の線の近く、線はその線の近く（内側の空いたところはつかめない） */
export function canGrabShape(shape: Shape, x: number, y: number, tolerance: number): boolean {
  if (shape.kind === 'rect') {
    const [rx, ry, rw, rh] = shape.rect
    const outer = x >= rx - tolerance && x <= rx + rw + tolerance && y >= ry - tolerance && y <= ry + rh + tolerance
    const inner = x > rx + tolerance && x < rx + rw - tolerance && y > ry + tolerance && y < ry + rh - tolerance
    return outer && !inner
  }
  const points = shape.points
  if (points.length === 1) return Math.hypot(x - points[0]![0], y - points[0]![1]) <= tolerance
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!
    const [bx, by] = points[i]!
    if (distanceToSegment(x, y, ax, ay, bx, by) <= tolerance) return true
  }
  return false
}

/** その点でつかめる形。重なっていたら後から描いた（上にある）ほう */
export function grabShapeAt(state: ShapeState, x: number, y: number, tolerance: number): Shape | undefined {
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    const shape = state.shapes[i]!
    if (canGrabShape(shape, x, y, tolerance)) return shape
  }
  return undefined
}

function pushUndo(state: ShapeState, step: ShapeStep): ShapeStep[] {
  return [...state.undo, step].slice(-MAX_STEPS)
}

/** 描き終えた形を足す */
export function addShape(state: ShapeState, shape: Shape): ShapeChange {
  return {
    state: { shapes: [...state.shapes, shape], undo: pushUndo(state, { kind: 'add', shape }), redo: [] },
    records: [{ type: 'draw', shape }]
  }
}

/** 形を動かす。動いていなければ null（ただのクリックは1手にしない） */
export function moveShape(state: ShapeState, key: number, dx: number, dy: number, newId: string): ShapeChange | null {
  const from = state.shapes.find((s) => s.key === key)
  if (!from || (dx === 0 && dy === 0)) return null
  const to = { ...translateShape(from, dx, dy), id: newId }
  return {
    state: {
      shapes: state.shapes.map((s) => (s.key === key ? to : s)),
      undo: pushUndo(state, { kind: 'move', key, from, to }),
      redo: []
    },
    records: [{ type: 'draw', shape: to, replaces: from.id }]
  }
}

/** ［消去］。見た目だけ片付ける（記録は消さない）ので、送るものは無い。元に戻すと画面に戻る */
export function clearShapes(state: ShapeState): ShapeChange {
  if (state.shapes.length === 0) return { state, records: [] }
  return {
    state: { shapes: [], undo: pushUndo(state, { kind: 'clear', shapes: state.shapes }), redo: [] },
    records: []
  }
}

/** 位置と見た目は geometry のもの、印と ID は指定のもの */
function withIdentity(geometry: Shape, key: number, id: string): Shape {
  return { ...geometry, key, id }
}

/** 一つ前に戻す。戻すものが無ければ null。newId は戻した結果を記録へ送るときの新しい ID */
export function undoShapes(state: ShapeState, newId: () => string): ShapeChange | null {
  const step = state.undo.at(-1)
  if (!step) return null
  const undo = state.undo.slice(0, -1)
  const redo = [...state.redo, step]
  if (step.kind === 'add') {
    const current = state.shapes.find((s) => s.key === step.shape.key)
    if (!current) return { state: { ...state, undo, redo }, records: [] }
    return {
      state: { shapes: state.shapes.filter((s) => s.key !== current.key), undo, redo },
      records: [{ type: 'erase', ids: [current.id] }]
    }
  }
  if (step.kind === 'move') {
    const current = state.shapes.find((s) => s.key === step.key)
    if (!current) return { state: { ...state, undo, redo }, records: [] }
    const back = withIdentity(step.from, step.key, newId())
    return {
      state: { shapes: state.shapes.map((s) => (s.key === step.key ? back : s)), undo, redo },
      records: [{ type: 'draw', shape: back, replaces: current.id }]
    }
  }
  // 消去を戻す: 片付けた形を画面に戻す（記録からは消していないので送るものは無い）
  return { state: { shapes: [...state.shapes, ...step.shapes], undo, redo }, records: [] }
}

/** 戻したものをやり直す。やり直すものが無ければ null */
export function redoShapes(state: ShapeState, newId: () => string): ShapeChange | null {
  const step = state.redo.at(-1)
  if (!step) return null
  const redo = state.redo.slice(0, -1)
  if (step.kind === 'add') {
    const again = withIdentity(step.shape, step.shape.key, newId())
    return {
      state: { shapes: [...state.shapes, again], undo: pushUndo(state, { kind: 'add', shape: again }), redo },
      records: [{ type: 'draw', shape: again }]
    }
  }
  if (step.kind === 'move') {
    const current = state.shapes.find((s) => s.key === step.key)
    if (!current) return { state: { ...state, redo }, records: [] }
    const moved = withIdentity(step.to, step.key, newId())
    return {
      state: {
        shapes: state.shapes.map((s) => (s.key === step.key ? moved : s)),
        undo: pushUndo(state, { kind: 'move', key: step.key, from: current, to: moved }),
        redo
      },
      records: [{ type: 'draw', shape: moved, replaces: current.id }]
    }
  }
  const keys = new Set(step.shapes.map((s) => s.key))
  const cleared = state.shapes.filter((s) => keys.has(s.key))
  return {
    state: { shapes: state.shapes.filter((s) => !keys.has(s.key)), undo: pushUndo(state, { kind: 'clear', shapes: cleared }), redo },
    records: []
  }
}
