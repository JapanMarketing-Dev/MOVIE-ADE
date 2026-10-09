import { contextBridge, ipcRenderer } from 'electron'
import { isPageChange } from '../shared/page'
import { acceptClick, isSameOriginNavigation, type LastClick } from '../shared/reviewInput'
import { DEFAULT_ANNOTATION_COLOR, annotationKeyAction, normalizeAnnotationColor, rectFromDrag, type AnnotationColor } from '../shared/annotation'
import { canRedoShapes, canUndoShapes, shapeBounds, type ShapeChange } from '../shared/annotationShapes'
import { paintShape, penCursor, preparePenContext } from '../shared/annotationPaint'
import { ShapeDrawing } from '../shared/annotationPointer'
import { createNoteBox, createNoteEditor, updateNoteBox } from '../shared/noteEditorDom'
import { MAX_NOTE_TEXT, NOTE_CHANNELS, noteBoxFromClick } from '../shared/textNote'

/**
 * レビュー対象のページへ入れる注入スクリプト（設計4章「ペン」）。
 * 依頼は声と書き込み（手書きの線・四角の枠）で行う。画面に文字を置く道具（旧 TXT-1）は廃止した。
 * 書き込みは形のデータ（src/shared/annotationShapes.ts）で持ち、描き直しはその一覧から行う。
 * 描いた形は線の近くをつかんで動かせ、描く・動かす・消去を1手として元に戻す／やり直すができる。
 * 描く手順・見た目・文字で指摘の欄は、共有リンクの相手の画面と同じ部品を使う
 * （src/shared/annotationPointer.ts・annotationPaint.ts・noteEditorDom.ts）。

 *
 * preload として読み込むので、**ページ本体のスクリプトとは別の世界**で動く
 * （contextIsolation 有効。ページ側から見えず、ページ側の変数ともぶつからない）。
 * ページが遷移するたびに Electron が読み直すので、SPAでない遷移でも必ず効く。
 *
 * ページを壊さないために守っていること:
 * - スタイルは必ず `el.style.prop = …` で入れる。`setAttribute('style', …)` と
 *   `<style>` 要素は、ページのCSP（style-src）に弾かれることがある。
 * - `innerHTML` を使わない（CSP と、ページ側の MutationObserver への影響を避ける）。
 * - 重ねる層は Top Layer（popover）に置く。ページ側がどんな z-index を使っていても上に出る。
 *   popover が使えない場合だけ、最大 z-index にして `documentElement` の末尾に足す。
 * - ペンOFFのときは `pointer-events: none`。ページの操作は素通しする（PEN-2）。
 */

const CH = {
  event: 'ade-review:event',
  command: 'ade-review:command',
  ready: 'ade-review:ready',
  history: 'ade-review:history',
  shortcut: 'ade-review:shortcut'
} as const

type PenMode = 'off' | 'pen' | 'rect'

interface Command {
  /**
   * leave  … SPA でページが変わった。描きかけの線を確定し、left を返す
   * commit … 別のドキュメントへ移る直前。描きかけの線を確定するだけ
   */
  type: 'mode' | 'clear' | 'enable' | 'disable' | 'config' | 'leave' | 'commit' | 'color' | 'undo' | 'redo' | 'note' | 'noteResult'
  mode?: PenMode
  /** note のとき、文字で指摘の入・切（録画とは別のモード。エディタで録画していないときだけ） */
  enable?: boolean
  /** note のとき、欄に出す文言（main が利用者の言語で渡す） */
  labels?: { placeholder?: string; hint?: string; add?: string }
  /** noteResult のとき、足せたか */
  ok?: boolean
  /** 書き込みの色（color と config のとき） */
  color?: AnnotationColor
  /** clear のとき、ページが変わったので消す（新しいページへ持ち越さない） */
  page?: boolean
  /** clear のとき、ツールバーの［消去］から（元に戻すで画面に戻せる）。無ければ戻す手順も片付ける */
  manual?: boolean
  /** 消し忘れの保険の上限(ms)。0 以下で保険なし */
  maxHoldMs?: number
}

/** main へ送る操作ログ。時刻は epoch ms で送り、main が録画時計へ直す */
interface RawEvent {
  at: number
  /** left はページ移動に伴う確定が済んだ返事（操作ログには残さない） */
  type: 'click' | 'scroll' | 'pen' | 'erase' | 'pointer' | 'left'
  [key: string]: unknown
}

/**
 * 消し忘れの保険（ms）。
 *
 * 線は本来、main からの `clear` 指示で消す（＝発話の区切り。設計4章）。
 * 指示が来ないまま残り続けると画面共有に写りっぱなしになるので、上限を置く。
 */
const DEFAULT_MAX_HOLD_MS = 30_000

/** 要素のセレクタの長さの上限（main の events.ts と同じ値） */
const MAX_SELECTOR_LENGTH = 300

let enabled = false
let mode: PenMode = 'off'
let color: AnnotationColor = DEFAULT_ANNOTATION_COLOR
let seq = 0
/**
 * このドキュメントの印。ペンの ID（p1）はページを読み直すたびに 1 から振り直されるので、
 * 1本の録画の中で対象を切り替えると別のページの書き込みと ID が重なり、静止画を取り違える。
 * ID の後ろにこの印を付けて、録画全体で重ならないようにする。
 */
const DOC_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

let maxHoldMs = DEFAULT_MAX_HOLD_MS
let layer: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let autoClearTimer: number | null = null
/** ページが変わったのに main から消す指示が来ないときの保険 */
let leaveTimer: number | null = null

function send(event: RawEvent): void {
  try {
    ipcRenderer.send(CH.event, { ...event, view: { width: window.innerWidth, height: window.innerHeight } })
  } catch {
    /* 録画していないときは受け手が居ない */
  }
}

// ───────────────────────── 要素の特定 ─────────────────────────

/** その場所にあるページ側の要素（重ねた層は一時的によけてから調べる） */
function elementUnder(x: number, y: number): Element | null {
  const saved = layer?.style.pointerEvents
  if (layer) layer.style.pointerEvents = 'none'
  const found = document.elementFromPoint(x, y)
  if (layer && saved !== undefined) layer.style.pointerEvents = saved
  if (!found || found === layer || layer?.contains(found)) return null
  return found
}

/** 短くて一意なCSSセレクタ。id があればそこで打ち切る */
function selectorFor(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  let depth = 0
  while (current && current.nodeType === 1 && depth < 6) {
    if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
      parts.unshift(`#${current.id}`)
      break
    }
    let part = current.localName
    const className = typeof current.className === 'string' ? current.className.trim() : ''
    const firstClass = className.split(/\s+/).find((c) => /^[A-Za-z][\w-]*$/.test(c))
    if (firstClass) part += `.${firstClass}`
    const parent: Element | null = current.parentElement
    if (parent) {
      const sameKind = Array.from(parent.children).filter(
        (c) => c.localName === current?.localName
      )
      if (sameKind.length > 1) part += `:nth-of-type(${sameKind.indexOf(current) + 1})`
    }
    parts.unshift(part)
    current = parent
    depth++
  }
  // クラス名や id はページが自由に決めるので、長いまま送らない（main でも切る）
  return parts.join(' > ').slice(0, MAX_SELECTOR_LENGTH)
}

function describe(x: number, y: number): { selector: string; text?: string; sensitive?: boolean } | undefined {
  const element = elementUnder(x, y)
  if (!element) return undefined
  if (element.matches('input, textarea, [contenteditable]')) return { selector: selectorFor(element), sensitive: true }
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return text ? { selector: selectorFor(element), text } : { selector: selectorFor(element) }
}

// ───────────────────────── 重ねる層 ─────────────────────────

function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer

  const root = document.createElement('div')
  root.style.position = 'fixed'
  root.style.left = '0px'
  root.style.top = '0px'
  root.style.width = '100%'
  root.style.height = '100%'
  root.style.margin = '0px'
  root.style.padding = '0px'
  root.style.border = '0px'
  root.style.background = 'transparent'
  root.style.overflow = 'hidden'
  root.style.pointerEvents = 'none'
  root.style.zIndex = '2147483647'

  const element = document.createElement('canvas')
  element.style.position = 'absolute'
  element.style.left = '0px'
  element.style.top = '0px'
  element.style.width = '100%'
  element.style.height = '100%'
  root.append(element)

  document.documentElement.append(root)

  // Top Layer に載せると、ページ側の z-index に関係なく最前面になる
  try {
    root.setAttribute('popover', 'manual')
    ;(root as HTMLElement & { showPopover(): void }).showPopover()
    // popover の既定の見た目を消す
    root.style.inset = '0px'
    root.style.maxWidth = 'none'
    root.style.maxHeight = 'none'
  } catch {
    // popover が使えない環境。最大 z-index のまま使う
  }

  layer = root
  canvas = element
  resizeCanvas()
  watchTopLayer()
  return root
}

/*
 * ページがあとから開いたダイアログ（<dialog> の showModal・popover）は、Top Layer で描く層の上に来る。
 * モーダルのダイアログが開くと、その外は操作できない（inert）ので、枠・ペン・文字の指摘が効かなくなる（ユーザーの指摘）。
 * 開いたら層をそのダイアログの中へ移して Top Layer の一番上に載せ直し、閉じたら元へ戻す。
 * Top Layer の要素は DOM のどこにあっても画面全体を基準に置かれるので、ダイアログの中へ移しても位置は変わらない
 */
let topLayerWatched = false
let raiseQueued = false

/** いま開いているモーダルのダイアログ（後ろにあるものほど後から開いた見込み） */
function openModalDialog(): HTMLDialogElement | null {
  if (typeof document.querySelectorAll !== 'function') return null
  const dialogs = Array.from(document.querySelectorAll('dialog')).filter((d) => {
    try { return d.matches(':modal') } catch { return d.open }
  })
  return dialogs.at(-1) ?? null
}

/** 層を、開いているモーダルの中（無ければ documentElement）へ置き、Top Layer の一番上に載せ直す */
function raiseLayer(): void {
  raiseQueued = false
  const root = layer
  if (!root) return
  const host: Element = openModalDialog() ?? document.documentElement
  const focused = document.activeElement
  const popover = root as HTMLElement & { showPopover(): void; hidePopover(): void }
  try {
    if (root.parentNode !== host) host.append(root)
    if (root.matches(':popover-open')) popover.hidePopover()
    popover.showPopover()
  } catch {
    // popover が使えない環境。最大 z-index のまま使う
  }
  // 文字の指摘を打っている途中なら、入力欄へ戻す（移すとフォーカスが外れる）
  if (focused instanceof HTMLElement && root.contains(focused) && document.activeElement !== focused) focused.focus()
}

function queueRaise(): void {
  if (raiseQueued) return
  raiseQueued = true
  queueMicrotask(raiseLayer)
}

function watchTopLayer(): void {
  if (topLayerWatched) return
  topLayerWatched = true
  // DOM の仕組みが揃っていない環境（単体テストの偽の DOM）では見ない
  if (typeof MutationObserver === 'undefined' || typeof HTMLDialogElement === 'undefined') return
  // popover・dialog の開閉（toggle は popover と dialog で出る。dialog の close も拾う）
  document.addEventListener('toggle', (event) => { if (event.target !== layer) queueRaise() }, true)
  document.addEventListener('close', () => queueRaise(), true)
  // showModal は属性 open を付ける。toggle を出さないブラウザでも拾えるように属性の変化も見る
  new MutationObserver((records) => {
    if (records.some((r) => r.type === 'attributes' && r.target instanceof HTMLDialogElement)) queueRaise()
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] })
  // 層を入れたダイアログをページが DOM から外したときは、層を documentElement へ戻す（描いたものは一覧から描き直る）
  new MutationObserver(() => {
    const root = layer
    if (root && !root.isConnected) {
      document.documentElement.append(root)
      queueRaise()
    }
  }).observe(document.documentElement, { subtree: true, childList: true })
}

/*
 * ページの「フォーカスをダイアログの中に閉じ込める」仕組み（focusin を見て戻す）が、文字の指摘の入力欄からフォーカスを奪わないようにする。
 * window の capture で、層の中へのフォーカスだけ先に止める（ページのリスナーは document 以下なので後に動く）
 */
window.addEventListener('focusin', (event) => {
  if (layer && event.target instanceof Node && layer.contains(event.target)) event.stopImmediatePropagation()
}, true)

/*
 * 拡張機能のポップアップ（chrome-extension:）は、中身の大きさに合わせてポップアップの大きさが決まる（preferred size）。
 * 層を画面いっぱい（100%）にすると、層の大きさが中身に数えられてポップアップが上限まで広がる。
 * ポップアップでは層を、層を除いた中身の大きさ（px）にする
 */
const IN_EXTENSION_PAGE = typeof location !== 'undefined' && location.protocol === 'chrome-extension:'
let contentObserved = false

function layerSize(): { width: number; height: number } {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  if (!IN_EXTENSION_PAGE || !document.body) return viewport
  const root = layer
  const display = root?.style.display ?? ''
  if (root) root.style.display = 'none'
  const width = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
  const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
  if (root) root.style.display = display
  return { width: Math.min(viewport.width, width) || viewport.width, height: Math.min(viewport.height, height) || viewport.height }
}

function resizeCanvas(): void {
  if (!canvas) return
  const ratio = window.devicePixelRatio || 1
  const size = layerSize()
  if (IN_EXTENSION_PAGE && layer) {
    layer.style.width = `${size.width}px`
    layer.style.height = `${size.height}px`
    layer.style.right = 'auto'
    layer.style.bottom = 'auto'
    if (!contentObserved && typeof ResizeObserver !== 'undefined' && document.body) {
      contentObserved = true
      new ResizeObserver(() => resizeCanvas()).observe(document.body)
    }
  }
  canvas.width = Math.floor(size.width * ratio)
  canvas.height = Math.floor(size.height * ratio)
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  preparePenContext(ctx)
  // 大きさを変えるとキャンバスが空になるので、一覧から描き直す
  redraw()
}

/** 一覧から全部描き直す。つかんで動かしている形はずらした位置に、描いている途中の形は最後に描く */
function redraw(): void {
  if (!ctx || !canvas) return
  const ratio = window.devicePixelRatio || 1
  ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio)
  for (const shape of drawing.visible()) paintShape(ctx, shape)
}

/**
 * 書き込みを片付ける。
 * manual … ツールバーの［消去］。1手として残し、元に戻すで画面に戻せる
 * それ以外（スクロール・発話の区切り・ページ遷移・消し忘れの保険）… 戻す手順ごと片付ける
 */
function clearAll(manual = false): void {
  drawing.clear(manual)
  if (autoClearTimer !== null) {
    window.clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
  reportHistory()
}

/**
 * ページを離れる前に、描きかけの線・動かしかけの形を確定して main へ送る。
 * 書き込みはその画面だけのもの（新しいページへ引き継がない）だが、記録からは失わない。
 */
function commitPending(): void {
  if (drawing.busy) drawing.finish()
}

/**
 * 消し忘れの保険を張り直す。
 * 通常は main から `clear` が来て消える。来なかったときだけここで消す。
 */
function armSafetyClear(): void {
  if (autoClearTimer !== null) window.clearTimeout(autoClearTimer)
  autoClearTimer = null
  if (maxHoldMs > 0) autoClearTimer = window.setTimeout(() => clearAll(), maxHoldMs)
}

let shownCursor = ''
/** カーソル。つかめる形の上（と動かしている間）は move、それ以外は道具のカーソル */
function updateCursor(x?: number, y?: number): void {
  if (!layer) return
  const overShape = x !== undefined && y !== undefined && mode !== 'off' && drawing.canGrab(x, y)
  const next = drawing.grab || overShape ? 'move' : mode === 'pen' ? penCursor(color) : mode === 'rect' ? 'crosshair' : 'auto'
  if (next === shownCursor) return
  shownCursor = next
  layer.style.cursor = next
}

function applyMode(): void {
  if (!layer) return
  const drawing = enabled && mode !== 'off'
  layer.style.pointerEvents = drawing || noteActive ? 'auto' : 'none'
  shownCursor = ''
  if (!drawing && noteActive) {
    shownCursor = 'crosshair'
    layer.style.cursor = 'crosshair'
    return
  }
  updateCursor()
}

let lastHistory = ''
/** 元に戻す／やり直すができるかを main（ツールバーのボタン）へ知らせる。変わったときだけ */
function reportHistory(): void {
  const history = { canUndo: canUndoShapes(drawing.shapes), canRedo: canRedoShapes(drawing.shapes) }
  const key = `${history.canUndo}${history.canRedo}`
  if (key === lastHistory) return
  lastHistory = key
  try {
    ipcRenderer.send(CH.history, history)
  } catch {
    /* 受け手が居ない */
  }
}

// ───────────────────────── 書き込み（描く・つかんで動かす・元に戻す） ─────────────────────────

/** 記録の ID。動かす・戻すたびに新しくする（操作ログは追記のみ。前の ID は replaces で指す） */
const newId = (): string => `p${++seq}-${DOC_TAG}`

/** 描いた形の一覧と、描く・つかんで動かす・元に戻すの手順（共有リンクの相手の画面と同じ部品。src/shared/annotationPointer.ts） */
const drawing = new ShapeDrawing({ newId, onApply: (change, atStart) => apply(change, atStart), onRedraw: () => redraw() })

function onPointerDown(event: PointerEvent): void {
  if (noteActive && !enabled) return notePointerDown(event)
  // 重ねた層はページの DOM の中にあるので、ページのスクリプトが合成の pointer イベントを送れる。人の操作だけで描く
  if (!enabled || mode === 'off' || !ctx || !event.isTrusted) return
  event.preventDefault()
  event.stopPropagation()
  if (autoClearTimer !== null) {
    window.clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
  drawing.down(event.clientX, event.clientY, mode, color)
  if (drawing.grab) updateCursor(event.clientX, event.clientY)
  layer?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!event.isTrusted) return
  if (noteActive && !enabled) return notePointerMove(event)
  if (drawing.move(event.clientX, event.clientY)) {
    event.preventDefault()
    return
  }
  updateCursor(event.clientX, event.clientY)
}

function onPointerUp(event: PointerEvent): void {
  if (noteActive && !enabled) return notePointerUp(event)
  if (!event.isTrusted || !drawing.busy) return
  if (layer?.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId)
  drawing.finish()
  updateCursor(event.clientX, event.clientY)
}

/** 一つ前に戻す・やり直す。描いている途中や、戻すものが無いときは false */
const undo = (): boolean => drawing.undo()
const redo = (): boolean => drawing.redo()

/** 一覧を変えた結果を記録へ送る（操作ログは追記のみ）。描き直しは ShapeDrawing が済ませている */
function apply(change: ShapeChange, atStart: number): void {
  const at = Date.now()
  for (const record of change.records) {
    if (record.type === 'erase') {
      send({ at, type: 'erase', ids: record.ids })
      continue
    }
    const [x, y, w, h] = shapeBounds(record.shape)
    send({
      at,
      atStart,
      type: 'pen',
      id: record.shape.id,
      ...(record.shape.kind === 'rect' ? { shape: 'rect' } : {}),
      ...(record.replaces ? { replaces: record.replaces } : {}),
      bbox: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)],
      el: describe(x + w / 2, y + h / 2)
    })
  }
  if (drawing.shapes.shapes.length > 0) armSafetyClear()
  else if (autoClearTimer !== null) {
    window.clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
  reportHistory()
}

// ───────────────────────── 文字で指摘（エディタ。録画しない） ─────────────────────────

/*
 * エディタの内蔵ブラウザ・映したウインドウの上で、枠を引いて（クリックだけなら指した要素を囲んで）指示を打つ。
 * Enter で足す・Shift+Enter で改行・Esc で取り消す。IME の変換中の Enter では送らない（shared/textNote.ts の noteKeyAction）。
 * 足すときは欄を隠してから送り、main が枠の写った画面を1枚撮る。足せたら枠を消し、続けて次の枠を引ける。
 * 録画の書き込み（enabled・mode）とは別の状態で持ち、録画が始まったら切る。
 */
let noteActive = false
let noteColor: AnnotationColor = DEFAULT_ANNOTATION_COLOR
let noteLabels: { placeholder: string; hint: string; add: string } = { placeholder: '', hint: 'Enter ↵', add: '+' }
/** いま開いている枠（ビューの CSS ピクセル）と、指した要素 */
let noteRect: [number, number, number, number] | null = null
let noteEl: ReturnType<typeof describe>
let noteDrag: { x0: number; y0: number; x1: number; y1: number } | null = null
/** main の返事を待っている（欄は隠してある） */
let noteSending = false
let noteBox: HTMLDivElement | null = null
let noteEditor: HTMLDivElement | null = null
let noteInput: HTMLTextAreaElement | null = null

function insideNoteEditor(target: EventTarget | null): boolean {
  return !!noteEditor && target instanceof Node && noteEditor.contains(target)
}

function showNoteBox(rect: [number, number, number, number]): void {
  const root = ensureLayer()
  if (!noteBox) {
    noteBox = createNoteBox(document)
    root.append(noteBox)
  }
  updateNoteBox(noteBox, rect, noteColor)
}

/** 開いている枠と欄を片付ける（取り消し・足し終えた・モードを切った） */
function closeNote(): void {
  noteBox?.remove()
  noteEditor?.remove()
  noteBox = null
  noteEditor = null
  noteInput = null
  noteRect = null
  noteEl = undefined
  noteDrag = null
  noteSending = false
}

function openNoteEditor(rect: [number, number, number, number]): void {
  const root = ensureLayer()
  noteEditor?.remove()
  const editor = createNoteEditor(document, {
    rect, view: { width: window.innerWidth, height: window.innerHeight }, color: noteColor, labels: noteLabels,
    onSubmit: (text) => submitNote(text), onCancel: () => closeNote()
  })
  root.append(editor.panel)
  noteEditor = editor.panel
  noteInput = editor.input
  window.setTimeout(() => editor.input.focus(), 0)
}

function notePointerDown(event: PointerEvent): void {
  if (!event.isTrusted || insideNoteEditor(event.target)) return
  event.preventDefault()
  event.stopPropagation()
  if (noteSending) return
  // 打ちかけの文があれば失わない（欄へ戻す）。空なら引き直す
  if (noteInput && noteInput.value.trim()) {
    noteInput.focus()
    return
  }
  closeNote()
  noteDrag = { x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY }
  showNoteBox([event.clientX, event.clientY, 0, 0])
  layer?.setPointerCapture(event.pointerId)
}

function notePointerMove(event: PointerEvent): void {
  if (!noteDrag || insideNoteEditor(event.target)) return
  event.preventDefault()
  noteDrag.x1 = event.clientX
  noteDrag.y1 = event.clientY
  showNoteBox(rectFromDrag(noteDrag.x0, noteDrag.y0, noteDrag.x1, noteDrag.y1, 0) ?? [noteDrag.x0, noteDrag.y0, 0, 0])
}

function notePointerUp(event: PointerEvent): void {
  if (!event.isTrusted || !noteDrag) return
  if (layer?.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId)
  const { x0, y0, x1, y1 } = noteDrag
  noteDrag = null
  const view = { width: window.innerWidth, height: window.innerHeight }
  const dragged = rectFromDrag(x0, y0, x1, y1, 6)
  // クリックだけなら、指した要素（ほどよい大きさのとき）を囲む
  const element = dragged ? null : elementUnder(x1, y1)?.getBoundingClientRect() ?? null
  const rect: [number, number, number, number] = dragged
    ? [Math.round(dragged[0]), Math.round(dragged[1]), Math.round(dragged[2]), Math.round(dragged[3])]
    : noteBoxFromClick(x1, y1, view, element)
  noteRect = rect
  noteEl = describe(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
  showNoteBox(rect)
  openNoteEditor(rect)
}

/** 欄を隠してから送る（枠だけが写った画面を main が撮る）。返事（noteResult）まで次は送らない */
function submitNote(text: string): void {
  if (noteSending || !noteInput || !noteRect) return
  noteSending = true
  if (noteEditor) noteEditor.style.display = 'none'
  const rect = noteRect
  const el = noteEl
  // 欄を消した描画が画面に反映されてから送る
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      ipcRenderer.send(NOTE_CHANNELS.submit, { at: Date.now(), text: text.slice(0, MAX_NOTE_TEXT), bbox: rect, ...(el ? { el } : {}),
        view: { width: window.innerWidth, height: window.innerHeight } })
    } catch {
      noteSending = false
      if (noteEditor) noteEditor.style.display = ''
    }
  }))
}

function noteResult(ok: boolean): void {
  if (!noteSending) return
  if (ok) {
    // 足せた。枠を消して、続けて次の枠を引けるようにする（モードはそのまま）
    closeNote()
    return
  }
  // 足せなかった。打った文は残して欄を戻す
  noteSending = false
  if (noteEditor) noteEditor.style.display = ''
  noteInput?.focus()
}

function setNoteMode(command: Command): void {
  const next = command.enable === true
  if (command.color !== undefined) noteColor = normalizeAnnotationColor(command.color)
  if (command.labels) {
    noteLabels = {
      placeholder: typeof command.labels.placeholder === 'string' ? command.labels.placeholder : noteLabels.placeholder,
      hint: typeof command.labels.hint === 'string' ? command.labels.hint : noteLabels.hint,
      add: typeof command.labels.add === 'string' ? command.labels.add : noteLabels.add
    }
  }
  if (!next) closeNote()
  noteActive = next
  if (next) ensureLayer()
  applyMode()
}

// ───────────────────────── 操作ログ ─────────────────────────

let lastScrollSent = 0

function install(): void {
  ensureLayer()
  applyMode()

  layer?.addEventListener('pointerdown', onPointerDown)
  layer?.addEventListener('pointermove', onPointerMove)
  layer?.addEventListener('pointerup', onPointerUp)
  layer?.addEventListener('pointercancel', onPointerUp)

  let lastPointer = 0
  document.addEventListener('pointermove', (event) => {
    const now = Date.now()
    if (!enabled || !event.isTrusted || now - lastPointer < 100) return
    lastPointer = now
    send({ at: now, type: 'pointer', x: event.clientX, y: event.clientY })
  }, { passive: true })

  // ページ側の操作は捕捉のみ（止めない）
  let lastClick: LastClick | null = null
  document.addEventListener(
    'click',
    (event) => {
      if (!enabled || mode !== 'off') return
      // 合成のクリック（element.click()・dispatchEvent）は記録しない。ダブルクリック・連打は1件にまとめる
      const now = Date.now()
      const accepted = acceptClick(event, lastClick, now)
      if (!accepted) return
      lastClick = accepted
      send({
        at: now,
        type: 'click',
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        el: describe(event.clientX, event.clientY)
      })
    },
    true
  )

  window.addEventListener(
    'scroll',
    (event) => {
      // 合成の scroll イベントで書き込みを消したり、操作ログを積んだりさせない（本物のスクロールは isTrusted）
      if (!enabled || !event.isTrusted) return
      // スクロールで線は消える（設計4章）
      clearAll()
      const now = Date.now()
      if (now - lastScrollSent < 200) return // 連続するスクロールは間引く
      lastScrollSent = now
      send({ at: now, type: 'scroll', y: Math.round(window.scrollY) })
    },
    true
  )

  window.addEventListener('resize', resizeCanvas)
}

ipcRenderer.on(CH.command, (_event, command: Command) => {
  switch (command.type) {
    case 'enable':
      // 録画が始まった。文字で指摘は切る（録画の書き込みと取り違えない）
      if (noteActive) setNoteMode({ type: 'note', enable: false })
      enabled = true
      ensureLayer()
      applyMode()
      break
    case 'disable':
      heldMode = null
      enabled = false
      mode = 'off'
      clearAll()
      applyMode()
      break
    case 'mode':
      mode = command.mode ?? 'off'
      applyMode()
      break
    case 'clear':
      if (leaveTimer !== null) window.clearTimeout(leaveTimer)
      leaveTimer = null
      // ツールバーの［消去］（manual）、発話の区切り（SilenceSegmenter の区切り）、ページが変わったとき（page）に main から呼ばれる
      clearAll(command.manual === true && !command.page)
      break
    case 'undo':
      undo()
      break
    case 'redo':
      redo()
      break
    case 'commit':
      commitPending()
      break
    case 'leave':
      // 直前の通知（beforeLeave）で確定済みのことが多い。描きかけの線が残っていれば確定する
      commitPending()
      // 確定した書き込みの静止画を main が撮り終えたら clear(page) が来る
      send({ at: Date.now(), type: 'left' })
      if (leaveTimer !== null) window.clearTimeout(leaveTimer)
      leaveTimer = window.setTimeout(() => {
        leaveTimer = null
        clearAll()
      }, 1500)
      break
    case 'config':
      if (typeof command.maxHoldMs === 'number') maxHoldMs = command.maxHoldMs
      if (command.color !== undefined) color = normalizeAnnotationColor(command.color)
      applyMode()
      break
    case 'note':
      setNoteMode(command)
      break
    case 'noteResult':
      noteResult(command.ok === true)
      break
    case 'color':
      // 色を変えても、もう描いた書き込みはそのまま。次に描くものから新しい色になる
      color = normalizeAnnotationColor(command.color)
      applyMode()
      break
  }
})

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install, { once: true })
} else {
  install()
}

// main に「このドキュメントで準備ができた」と知らせる。main は現在のモードを送り返す
ipcRenderer.send(CH.ready)

// ───────────────────────── 遷移の直前（SPA） ─────────────────────────

/*
 * SPA の遷移（history.pushState / replaceState、戻る・進む、ハッシュルーター）を、
 * 新しい画面に描き変わる「前」に捕まえて、描きかけの線を確定する。
 * 要素情報（describe）もこの時点なら前のページのものが取れる。
 * main の did-navigate-in-page は遷移の後にしか来ないので、ここで先回りする。
 *
 * pushState はページの世界（main world）の関数なので、そこで包む。ページ側からは
 * 遷移の直前に 'ade-review:before-navigate' イベントが window へ飛ぶだけに見える（同期で届く）。
 */
const BEFORE_NAVIGATE = 'ade-review:before-navigate'
let lastHref = window.location.href

function beforeLeave(next: string): void {
  const changed = isPageChange(lastHref, next)
  lastHref = next
  if (enabled && changed) commitPending()
}

try {
  contextBridge.executeInMainWorld({
    func: (eventName: string) => {
      for (const name of ['pushState', 'replaceState'] as const) {
        const original = history[name]
        history[name] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
          if (url !== undefined && url !== null) {
            let next = ''
            try { next = new URL(String(url), location.href).href } catch { /* 読めないURLはそのまま渡す */ }
            if (next) window.dispatchEvent(new CustomEvent(eventName, { detail: next }))
          }
          return original.call(this, data, unused, url)
        }
      }
    },
    args: [BEFORE_NAVIGATE]
  })
} catch {
  /* 包めないときは did-navigate-in-page の後の確定（leave）だけで動く */
}

window.addEventListener(BEFORE_NAVIGATE, (event) => {
  const next = (event as CustomEvent<unknown>).detail
  // ページのスクリプトも同じ名前のイベントを送れるので、pushState が受け付ける同じオリジンの URL だけを使う
  if (typeof next === 'string' && isSameOriginNavigation(next, window.location.href)) beforeLeave(next)
})
// 戻る・進む・ハッシュの変化は URL が変わった直後、ページ側の描き変え（ルーターの処理）より前に届く。
// この preload はページのスクリプトより先に登録するので、ルーターより先に呼ばれる
window.addEventListener('popstate', (event) => { if (event.isTrusted) beforeLeave(window.location.href) })
window.addEventListener('hashchange', (event) => { if (event.isTrusted) beforeLeave(event.newURL) })

// 外（Finder など）から落としたファイルを、ページが受けなかったときは開かない（内蔵ブラウザがそのファイルへ移ってしまわないように）。
// ページの落とし先（アップロード欄など）が受けたもの（defaultPrevented）はそのまま。window の bubble で、ページの要素の処理の後に見る
const blockUnhandledFileDrop = (event: DragEvent): void => {
  if (event.defaultPrevented || !event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return
  event.preventDefault()
  if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none'
}
window.addEventListener('dragover', blockUnhandledFileDrop)
window.addEventListener('drop', blockUnhandledFileDrop)

const MAC = process.platform === 'darwin'

/**
 * 録画中の書き込みのショートカット（P / B・R / V・Esc / C / ⌘Z・⌘⇧Z）。ページに焦点があるとき用。
 * 道具と色の切り替えはツールバー（renderer）が持つので main 経由で渡し、元に戻す／やり直すはここで行う。
 * ページの入力欄で打っているときは奪わない。書き込みなしのときの Esc・V と、戻すものが無いときの ⌘Z はページに任せる。
 */
window.addEventListener('keydown', (event) => {
  // ページのスクリプトが合成のキーで道具を切り替えたり、書き込みを戻したりできないようにする
  if (!enabled || !event.isTrusted || event.repeat || event.isComposing) return
  const target = event.target
  if (target instanceof Element && target.closest('input,textarea,select,[contenteditable]')) return
  const action = annotationKeyAction(event, MAC)
  if (!action) return
  if (action === 'undo' || action === 'redo') {
    if (!(action === 'undo' ? undo() : redo())) return
  } else {
    if (action === 'off' && mode === 'off') return
    try {
      ipcRenderer.send(CH.shortcut, action)
    } catch {
      return
    }
  }
  event.preventDefault()
  event.stopPropagation()
}, true)

// 文字で指摘の最中の Esc。開いている枠があれば取り消し、無ければ文字で指摘をやめる（main が切ってツールバーへ知らせる）
window.addEventListener('keydown', (event) => {
  if (!noteActive || enabled || !event.isTrusted || event.isComposing || event.key !== 'Escape') return
  if (insideNoteEditor(event.target)) return
  event.preventDefault()
  event.stopPropagation()
  if (noteRect || noteDrag) {
    if (!noteSending) closeNote()
    return
  }
  try {
    ipcRenderer.send(NOTE_CHANNELS.exit)
  } catch {
    /* 受け手が居ない */
  }
}, true)

// Option/Altを押している間だけ描く。ページ側の入力欄で打っているときは文字入力を優先する。
let heldMode: PenMode | null = null
window.addEventListener('keydown', (event) => {
  const target = event.target
  const editing = target instanceof Element && target.closest('input,textarea,[contenteditable]')
  if (!enabled || !event.isTrusted || event.key !== 'Alt' || event.repeat || editing) return
  heldMode = mode
  mode = 'pen'
  applyMode()
  event.preventDefault()
}, true)
function releaseHeldPen(): void {
  if (heldMode === null) return
  mode = heldMode
  heldMode = null
  // 描きかけは確定して送る（Alt を先に離しても線を失わない）
  commitPending()
  applyMode()
}
window.addEventListener('keyup', (event) => { if (event.isTrusted && event.key === 'Alt') releaseHeldPen() }, true)
window.addEventListener('blur', releaseHeldPen)
