import { rectFromDrag, type AnnotationColor } from './annotation'
import {
  addShape,
  clearShapes,
  emptyShapes,
  grabShapeAt,
  moveShape,
  redoShapes,
  translateShape,
  undoShapes,
  type Shape,
  type ShapeChange,
  type ShapeState
} from './annotationShapes'

/**
 * 書き込みの「描く・つかんで動かす・元に戻す／やり直す」の手順（ポインタの押す・動かす・離す）。
 * アプリの注入スクリプト（preload/review.ts）と、共有リンクの相手の画面（workers/feedback-share/client）が同じものを使う。
 *
 * DOM に触れない。座標（CSS ピクセル）と時刻を受け取り、形の一覧（annotationShapes）を変え、
 * 変えた結果（記録へ送るもの）を onApply で、描き直しを onRedraw で知らせる。描くのは呼び出し側（annotationPaint.ts の paintShape）。
 */

export type DrawTool = 'pen' | 'rect'

export interface ShapeDrawingOptions {
  /** 記録の ID を作る。動かす・戻すたびに新しくする（操作ログは追記のみ。前の ID は replaces で指す） */
  newId: () => string
  /** 一覧を変えた（描いた・動かした・戻した・消去した）。atStart は描き始めた時刻 */
  onApply: (change: ShapeChange, atStart: number) => void
  /** 画面を描き直す */
  onRedraw: () => void
  now?: () => number
}

/** つかめる距離(px)。四角は枠の線、手書きの線はその線からこの距離まで */
export const GRAB_TOLERANCE = 6

export class ShapeDrawing {
  /** 描いた形の一覧と、元に戻す／やり直すの手順 */
  shapes: ShapeState = emptyShapes()
  /** 描いている途中の形。描き始めの道具で決まり、途中で道具を変えても変わらない */
  draft: Shape | null = null
  /** つかんで動かしている形 */
  grab: { key: number; startX: number; startY: number; dx: number; dy: number; startedAt: number } | null = null
  private shapeKey = 0
  private rectStart: [number, number] = [0, 0]
  private rectEnd: [number, number] = [0, 0]
  private strokeStart = 0
  private readonly now: () => number

  constructor(private readonly opt: ShapeDrawingOptions) {
    this.now = opt.now ?? Date.now
  }

  /** 描いている・動かしている途中か */
  get busy(): boolean {
    return this.draft !== null || this.grab !== null
  }

  /** いま画面に描く形（動かしている形はずらした位置に、描いている途中の形は最後に） */
  visible(): Shape[] {
    const grab = this.grab
    const shapes = this.shapes.shapes.map((shape) => (grab && grab.key === shape.key ? translateShape(shape, grab.dx, grab.dy) : shape))
    return this.draft ? [...shapes, this.draft] : shapes
  }

  /** その位置で形をつかめるか（カーソルを move にする） */
  canGrab(x: number, y: number): boolean {
    return grabShapeAt(this.shapes, x, y, GRAB_TOLERANCE) !== undefined
  }

  /** 押した。形の線の近くならつかむ。四角の内側の空いたところは、新しく描く */
  down(x: number, y: number, tool: DrawTool, color: AnnotationColor): void {
    this.strokeStart = this.now()
    const hit = grabShapeAt(this.shapes, x, y, GRAB_TOLERANCE)
    if (hit) {
      this.grab = { key: hit.key, startX: x, startY: y, dx: 0, dy: 0, startedAt: this.strokeStart }
    } else if (tool === 'rect') {
      this.rectStart = [x, y]
      this.rectEnd = [x, y]
      this.draft = { key: 0, id: '', color, kind: 'rect', rect: [x, y, 0, 0] }
    } else {
      this.draft = { key: 0, id: '', color, kind: 'pen', points: [[x, y]] }
    }
    this.opt.onRedraw()
  }

  /** 動かした。描いている・動かしている途中なら true（ページへ渡さない） */
  move(x: number, y: number): boolean {
    if (this.grab) {
      this.grab.dx = x - this.grab.startX
      this.grab.dy = y - this.grab.startY
      this.opt.onRedraw()
      return true
    }
    if (!this.draft) return false
    if (this.draft.kind === 'rect') {
      this.rectEnd = [x, y]
      const [x0, y0] = this.rectStart
      this.draft = { ...this.draft, rect: rectFromDrag(x0, y0, x, y, 0) ?? [x0, y0, 0, 0] }
    } else {
      this.draft.points.push([x, y])
    }
    this.opt.onRedraw()
    return true
  }

  /** 描いている形・動かしている形を確定する（指を離したとき・ページを離れるとき） */
  finish(): void {
    if (this.grab) {
      const { key, dx, dy, startedAt } = this.grab
      this.grab = null
      // ほとんど動いていなければ、ただのクリック（1手にしない）
      const change = Math.abs(dx) < 2 && Math.abs(dy) < 2 ? null : moveShape(this.shapes, key, Math.round(dx), Math.round(dy), this.opt.newId())
      if (change) this.apply(change, startedAt)
      else this.opt.onRedraw()
      return
    }
    let drawn = this.draft
    this.draft = null
    if (!drawn) return
    if (drawn.kind === 'rect') {
      const box = rectFromDrag(this.rectStart[0], this.rectStart[1], this.rectEnd[0], this.rectEnd[1])
      if (!box) {
        // クリックだけ（枠にならない）。描きかけを消し、記録にも残さない
        this.opt.onRedraw()
        return
      }
      drawn = { ...drawn, rect: box }
    }
    this.apply(addShape(this.shapes, { ...drawn, key: ++this.shapeKey, id: this.opt.newId() }), this.strokeStart)
  }

  /** 一つ前に戻す・やり直す。描いている途中や、戻すものが無いときは false */
  undo(): boolean {
    if (this.busy) return false
    const change = undoShapes(this.shapes, this.opt.newId)
    if (!change) return false
    this.apply(change, this.now())
    return true
  }

  redo(): boolean {
    if (this.busy) return false
    const change = redoShapes(this.shapes, this.opt.newId)
    if (!change) return false
    this.apply(change, this.now())
    return true
  }

  /**
   * 書き込みを片付ける。manual … ツールバーの［消去］。1手として残し、元に戻すで画面に戻せる。
   * それ以外（スクロール・発話の区切り・ページ遷移・消し忘れの保険）… 戻す手順ごと片付ける
   */
  clear(manual = false): void {
    this.draft = null
    this.grab = null
    this.shapes = manual ? clearShapes(this.shapes).state : emptyShapes()
    this.opt.onRedraw()
  }

  private apply(change: ShapeChange, atStart: number): void {
    this.shapes = change.state
    this.opt.onRedraw()
    this.opt.onApply(change, atStart)
  }
}
