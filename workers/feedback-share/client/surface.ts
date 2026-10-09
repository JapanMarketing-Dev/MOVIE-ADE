/**
 * 書き込む面（ライブのページ・画面共有の映像の上に重ねる層）。アプリの注入スクリプト（preload/review.ts）と同じ部品で描く:
 *   描く・つかんで動かす・元に戻す … src/shared/annotationPointer.ts（ShapeDrawing）
 *   見た目 … src/shared/annotationPaint.ts、文字で指摘の枠と欄 … src/shared/noteEditorDom.ts
 * 書いたもの・打ったものは、録画の時計の時刻と座標で記録する（ShareEvent。Ferret が取り込むときにアプリの録画の pen と同じに扱う）。
 * 画面共有では、映像の中の座標（映像のピクセル）に直して記録する（mapBox）。
 */
import { DEFAULT_ANNOTATION_COLOR, rectFromDrag, type AnnotationColor } from '../../../src/shared/annotation'
import { canRedoShapes, canUndoShapes, shapeBounds } from '../../../src/shared/annotationShapes'
import { paintShape, penCursor, preparePenContext } from '../../../src/shared/annotationPaint'
import { ShapeDrawing } from '../../../src/shared/annotationPointer'
import { createNoteBox, createNoteEditor, updateNoteBox, type NoteLabels } from '../../../src/shared/noteEditorDom'
import { noteBoxFromClick } from '../../../src/shared/textNote'
import type { ShareBox, ShareEvent, ShareNote } from '../../../src/shared/feedbackShare'

export type SurfaceTool = 'none' | 'pen' | 'rect'

/** 消し忘れの保険（アプリの録画と同じ 30 秒） */
const MAX_HOLD_MS = 30_000

export interface SurfaceOptions {
  /** 録画の時計（録っていなければ null。書けない） */
  clock: () => number | null
  labels: NoteLabels
  /** 面の座標の枠を、記録する座標（と面の大きさ）に直す。省けば面の CSS ピクセルのまま */
  mapBox?: (box: ShareBox) => { box: ShareBox; view: { width: number; height: number } } | null
  onHistory: (canUndo: boolean, canRedo: boolean) => void
  onNote: (note: ShareNote) => void
}

export class AnnotationSurface {
  readonly layer: HTMLDivElement
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null = null
  private tool: SurfaceTool = 'none'
  private noteMode = false
  private color: AnnotationColor = DEFAULT_ANNOTATION_COLOR
  private seq = 0
  private holdTimer: number | null = null
  readonly events: ShareEvent[] = []
  readonly notes: ShareNote[] = []
  private noteBox: HTMLDivElement | null = null
  private noteEditor: HTMLDivElement | null = null
  private noteDrag: { x0: number; y0: number; x1: number; y1: number } | null = null
  private noteRect: [number, number, number, number] | null = null
  private readonly drawing: ShapeDrawing
  private readonly resizeObserver: ResizeObserver

  constructor(private readonly host: HTMLElement, private readonly opt: SurfaceOptions) {
    const layer = document.createElement('div')
    layer.className = 'share-layer'
    const canvas = document.createElement('canvas')
    canvas.className = 'share-layer__canvas'
    layer.append(canvas)
    host.append(layer)
    this.layer = layer
    this.canvas = canvas
    this.drawing = new ShapeDrawing({
      newId: () => `s${++this.seq}`,
      now: () => opt.clock() ?? 0,
      onRedraw: () => this.redraw(),
      onApply: (change, atStart) => {
        const t = opt.clock() ?? 0
        for (const record of change.records) {
          if (record.type === 'erase') {
            this.events.push({ t, type: 'erase', ids: record.ids })
            continue
          }
          const [x, y, w, h] = shapeBounds(record.shape)
          const mapped = this.map([Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))])
          if (!mapped) continue
          this.events.push({ t: atStart, type: 'pen', id: record.shape.id, t_end: Math.max(atStart, t), bbox: mapped.box,
            ...(record.shape.kind === 'rect' ? { shape: 'rect' as const } : {}), ...(record.replaces ? { replaces: record.replaces } : {}) })
        }
        if (this.drawing.shapes.shapes.length > 0) this.armHold()
        this.report()
      }
    })
    layer.addEventListener('pointerdown', (e) => this.down(e))
    layer.addEventListener('pointermove', (e) => this.move(e))
    layer.addEventListener('pointerup', (e) => this.up(e))
    layer.addEventListener('pointercancel', (e) => this.up(e))
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.resize()
    this.apply()
  }

  /** 録る座標と大きさ（記録の view）。面の CSS ピクセルか、mapBox の結果 */
  private map(box: ShareBox): { box: ShareBox; view: { width: number; height: number } } | null {
    return this.opt.mapBox ? this.opt.mapBox(box) : { box, view: this.viewSize() }
  }

  viewSize(): { width: number; height: number } {
    return { width: Math.max(1, Math.round(this.host.clientWidth)), height: Math.max(1, Math.round(this.host.clientHeight)) }
  }

  setTool(tool: SurfaceTool): void {
    this.tool = tool
    this.apply()
  }

  setNoteMode(on: boolean): void {
    this.noteMode = on
    if (!on) this.closeNote()
    this.apply()
  }

  setColor(color: AnnotationColor): void {
    this.color = color
    this.apply()
  }

  undo(): void {
    this.drawing.undo()
  }

  redo(): void {
    this.drawing.redo()
  }

  /** ツールバーの［消去］（元に戻せる） */
  clear(): void {
    this.drawing.clear(true)
    this.report()
  }

  /** 録画を始める・終える（書き込みの状態を空にする） */
  reset(): void {
    this.drawing.clear(false)
    this.events.length = 0
    this.notes.length = 0
    this.closeNote()
    this.report()
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer)
    this.layer.remove()
  }

  private recording(): boolean {
    return this.opt.clock() !== null
  }

  private apply(): void {
    const drawing = this.recording() && this.tool !== 'none'
    const note = this.recording() && this.noteMode
    this.layer.style.pointerEvents = drawing || note ? 'auto' : 'none'
    this.layer.style.cursor = note && !drawing ? 'crosshair' : this.tool === 'pen' ? penCursor(this.color) : this.tool === 'rect' ? 'crosshair' : 'auto'
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1
    const { width, height } = this.viewSize()
    this.canvas.width = Math.floor(width * ratio)
    this.canvas.height = Math.floor(height * ratio)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx = this.canvas.getContext('2d')
    if (!this.ctx) return
    this.ctx.scale(ratio, ratio)
    preparePenContext(this.ctx)
    this.redraw()
    const t = this.opt.clock()
    if (t !== null) {
      const view = this.map([0, 0, width, height])?.view
      if (view) this.events.push({ t, type: 'view', ...view })
    }
  }

  private redraw(): void {
    if (!this.ctx) return
    const ratio = window.devicePixelRatio || 1
    this.ctx.clearRect(0, 0, this.canvas.width / ratio, this.canvas.height / ratio)
    for (const shape of this.drawing.visible()) paintShape(this.ctx, shape)
  }

  private report(): void {
    this.opt.onHistory(canUndoShapes(this.drawing.shapes), canRedoShapes(this.drawing.shapes))
  }

  private armHold(): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer)
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = null
      this.drawing.clear(false)
      this.report()
    }, MAX_HOLD_MS)
  }

  private point(e: PointerEvent): [number, number] {
    const rect = this.layer.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  private down(e: PointerEvent): void {
    if (!e.isTrusted || !this.recording()) return
    if (this.noteMode && this.tool === 'none') return this.noteDown(e)
    if (this.tool === 'none') return
    e.preventDefault()
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer)
    const [x, y] = this.point(e)
    this.drawing.down(x, y, this.tool, this.color)
    this.layer.setPointerCapture(e.pointerId)
  }

  private move(e: PointerEvent): void {
    if (!e.isTrusted) return
    if (this.noteDrag) return this.noteMove(e)
    const [x, y] = this.point(e)
    if (this.drawing.move(x, y)) {
      e.preventDefault()
      return
    }
    if (this.tool !== 'none' && this.recording()) this.layer.style.cursor = this.drawing.canGrab(x, y) ? 'move' : this.tool === 'pen' ? penCursor(this.color) : 'crosshair'
  }

  private up(e: PointerEvent): void {
    if (!e.isTrusted) return
    if (this.noteDrag) return this.noteUp(e)
    if (!this.drawing.busy) return
    if (this.layer.hasPointerCapture(e.pointerId)) this.layer.releasePointerCapture(e.pointerId)
    this.drawing.finish()
  }

  /* ── 文字で指摘（枠を引いて文を打つ。アプリの文字で指摘と同じ欄） ─────────── */

  private noteDown(e: PointerEvent): void {
    if (this.noteEditor && e.target instanceof Node && this.noteEditor.contains(e.target)) return
    e.preventDefault()
    const input = this.noteEditor?.querySelector('textarea')
    if (input && input.value.trim()) {
      input.focus()
      return
    }
    this.closeNote()
    const [x, y] = this.point(e)
    this.noteDrag = { x0: x, y0: y, x1: x, y1: y }
    this.showBox([x, y, 0, 0])
    this.layer.setPointerCapture(e.pointerId)
  }

  private noteMove(e: PointerEvent): void {
    if (!this.noteDrag) return
    e.preventDefault()
    const [x, y] = this.point(e)
    this.noteDrag.x1 = x
    this.noteDrag.y1 = y
    const d = this.noteDrag
    this.showBox(rectFromDrag(d.x0, d.y0, d.x1, d.y1, 0) ?? [d.x0, d.y0, 0, 0])
  }

  private noteUp(e: PointerEvent): void {
    const d = this.noteDrag
    if (!d) return
    this.noteDrag = null
    if (this.layer.hasPointerCapture(e.pointerId)) this.layer.releasePointerCapture(e.pointerId)
    const view = this.viewSize()
    const dragged = rectFromDrag(d.x0, d.y0, d.x1, d.y1, 6)
    // クリックだけなら、まわりの枠（ページの要素は別オリジンで読めないので、クリックの位置のまわり）
    const rect: [number, number, number, number] = dragged
      ? [Math.round(dragged[0]), Math.round(dragged[1]), Math.round(dragged[2]), Math.round(dragged[3])]
      : noteBoxFromClick(d.x1, d.y1, view, null)
    this.noteRect = rect
    this.showBox(rect)
    const editor = createNoteEditor(document, {
      rect, view, color: this.color, labels: this.opt.labels,
      onSubmit: (text) => this.submitNote(text), onCancel: () => this.closeNote()
    })
    this.layer.append(editor.panel)
    this.noteEditor = editor.panel
    window.setTimeout(() => editor.input.focus(), 0)
  }

  private showBox(rect: [number, number, number, number]): void {
    if (!this.noteBox) {
      this.noteBox = createNoteBox(document)
      this.layer.append(this.noteBox)
    }
    updateNoteBox(this.noteBox, rect, this.color)
  }

  private submitNote(text: string): void {
    const rect = this.noteRect
    const t = this.opt.clock()
    if (!rect || t === null) return
    const mapped = this.map([rect[0], rect[1], Math.max(1, rect[2]), Math.max(1, rect[3])])
    if (mapped) this.events.push({ t, type: 'note', id: `n${++this.seq}`, bbox: mapped.box, text })
    const note = { t, text }
    this.notes.push(note)
    this.opt.onNote(note)
    // 枠は少しだけ残して（録画に写す）、欄を閉じる
    this.noteEditor?.remove()
    this.noteEditor = null
    const box = this.noteBox
    this.noteBox = null
    this.noteRect = null
    window.setTimeout(() => box?.remove(), 2500)
  }

  private closeNote(): void {
    this.noteBox?.remove()
    this.noteEditor?.remove()
    this.noteBox = null
    this.noteEditor = null
    this.noteDrag = null
    this.noteRect = null
  }
}

/**
 * 画面共有の録画: 映像（video）に書き込みの層（canvas）を重ねて、1枚の canvas に合成して録る。
 * 書き込みの層は面いっぱい、映像は面の中に contain で置くので、映像の部分を切り出して重ねる
 */
export class ScreenComposer {
  readonly canvas = document.createElement('canvas')
  private timer: number | null = null
  constructor(private readonly video: HTMLVideoElement, private readonly overlay: HTMLCanvasElement, private readonly host: HTMLElement) {}

  /** 面の中の映像の位置（CSS ピクセル） */
  contentRect(): { x: number; y: number; w: number; h: number } {
    const W = this.host.clientWidth
    const H = this.host.clientHeight
    const vw = this.video.videoWidth || W
    const vh = this.video.videoHeight || H
    const scale = Math.min(W / vw, H / vh)
    const w = vw * scale
    const h = vh * scale
    return { x: (W - w) / 2, y: (H - h) / 2, w, h }
  }

  /** 面の座標の枠を、映像のピクセルの枠に直す */
  mapBox(box: ShareBox): { box: ShareBox; view: { width: number; height: number } } | null {
    const vw = this.video.videoWidth
    const vh = this.video.videoHeight
    if (!vw || !vh) return null
    const r = this.contentRect()
    const sx = vw / r.w
    const sy = vh / r.h
    const x = Math.max(0, Math.round((box[0] - r.x) * sx))
    const y = Math.max(0, Math.round((box[1] - r.y) * sy))
    const w = Math.max(1, Math.min(vw - x, Math.round(box[2] * sx)))
    const h = Math.max(1, Math.min(vh - y, Math.round(box[3] * sy)))
    return { box: [x, y, w, h], view: { width: vw, height: vh } }
  }

  start(fps = 15): MediaStream {
    const draw = () => {
      const vw = this.video.videoWidth
      const vh = this.video.videoHeight
      if (!vw || !vh) return
      if (this.canvas.width !== vw || this.canvas.height !== vh) {
        this.canvas.width = vw
        this.canvas.height = vh
      }
      const ctx = this.canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(this.video, 0, 0, vw, vh)
      const r = this.contentRect()
      const ratio = this.overlay.width / Math.max(1, this.host.clientWidth)
      ctx.drawImage(this.overlay, r.x * ratio, r.y * ratio, r.w * ratio, r.h * ratio, 0, 0, vw, vh)
    }
    draw()
    this.timer = window.setInterval(draw, Math.round(1000 / fps))
    return this.canvas.captureStream(fps)
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }
}
