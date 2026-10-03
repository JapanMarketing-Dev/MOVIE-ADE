import { contextBridge, ipcRenderer } from 'electron'
import { isPageChange } from '../shared/page'
import { acceptClick, isSameOriginNavigation, type LastClick } from '../shared/reviewInput'
import { ANNOTATION_COLORS, DEFAULT_ANNOTATION_COLOR, annotationKeyAction, normalizeAnnotationColor, rectFromDrag, type AnnotationColor } from '../shared/annotation'
import {
  addShape,
  canRedoShapes,
  canUndoShapes,
  clearShapes,
  emptyShapes,
  grabShapeAt,
  moveShape,
  redoShapes,
  shapeBounds,
  translateShape,
  undoShapes,
  type Shape,
  type ShapeChange,
  type ShapeState
} from '../shared/annotationShapes'

/**
 * レビュー対象のページへ入れる注入スクリプト（設計4章「ペン」）。
 * 依頼は声と書き込み（手書きの線・四角の枠）で行う。画面に文字を置く道具（旧 TXT-1）は廃止した。
 * 書き込みは形のデータ（src/shared/annotationShapes.ts）で持ち、描き直しはその一覧から行う。
 * 描いた形は線の近くをつかんで動かせ、描く・動かす・消去を1手として元に戻す／やり直すができる。

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
  type: 'mode' | 'clear' | 'enable' | 'disable' | 'config' | 'leave' | 'commit' | 'color' | 'undo' | 'redo'
  mode?: PenMode
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

/*
 * 書き込みの見た目。白いページでも暗いページでも読めるよう、
 * 選んだ色の線の下に白い縁を敷く。色は利用者が選ぶ（既定はローズ。src/shared/annotation.ts）。
 */
const PEN_HALO = 'rgba(255, 255, 255, 0.9)'
const PEN_WIDTH = 4
const PEN_HALO_WIDTH = PEN_WIDTH + 4
/** ペンのカーソル。選んだ色の点に白い縁（中心が描く位置）。読めない環境では crosshair */
function penCursor(): string {
  const fill = encodeURIComponent(penColor())
  return "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E" +
    `%3Ccircle cx='10' cy='10' r='5' fill='${fill}' stroke='white' stroke-width='2'/%3E%3C/svg%3E\") 10 10, crosshair`
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
const penColor = (): string => ANNOTATION_COLORS[color]
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
  return root
}

function resizeCanvas(): void {
  if (!canvas) return
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.floor(window.innerWidth * ratio)
  canvas.height = Math.floor(window.innerHeight * ratio)
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = penColor()
  ctx.lineWidth = PEN_WIDTH
  // 大きさを変えるとキャンバスが空になるので、一覧から描き直す
  redraw()
}

/** 形の輪郭をパスにする */
function tracePath(shape: Shape): void {
  if (!ctx) return
  ctx.beginPath()
  if (shape.kind === 'rect') {
    const [x, y, w, h] = shape.rect
    ctx.rect(x, y, w, h)
    return
  }
  const [first, ...rest] = shape.points
  if (!first) return
  ctx.moveTo(first[0], first[1])
  // 点を打っただけでも丸く見えるようにする
  if (rest.length === 0) ctx.lineTo(first[0], first[1])
  for (const [x, y] of rest) ctx.lineTo(x, y)
}

/** 形を、白い縁 → その形の色の順で描く */
function drawShape(shape: Shape): void {
  if (!ctx) return
  tracePath(shape)
  ctx.strokeStyle = PEN_HALO
  ctx.lineWidth = PEN_HALO_WIDTH
  ctx.stroke()
  ctx.strokeStyle = ANNOTATION_COLORS[shape.color]
  ctx.lineWidth = PEN_WIDTH
  ctx.stroke()
}

/** 一覧から全部描き直す。つかんで動かしている形はずらした位置に、描いている途中の形は最後に描く */
function redraw(): void {
  if (!ctx || !canvas) return
  const ratio = window.devicePixelRatio || 1
  ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio)
  for (const shape of shapes.shapes) {
    drawShape(grab && grab.key === shape.key ? translateShape(shape, grab.dx, grab.dy) : shape)
  }
  if (draft) drawShape(draft)
}

/**
 * 書き込みを片付ける。
 * manual … ツールバーの［消去］。1手として残し、元に戻すで画面に戻せる
 * それ以外（スクロール・発話の区切り・ページ遷移・消し忘れの保険）… 戻す手順ごと片付ける
 */
function clearAll(manual = false): void {
  draft = null
  grab = null
  shapes = manual ? clearShapes(shapes).state : emptyShapes()
  redraw()
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
  if (draft || grab) finishPointer()
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
  const overShape = x !== undefined && y !== undefined && mode !== 'off' && grabShapeAt(shapes, x, y, GRAB_TOLERANCE) !== undefined
  const next = grab || overShape ? 'move' : mode === 'pen' ? penCursor() : mode === 'rect' ? 'crosshair' : 'auto'
  if (next === shownCursor) return
  shownCursor = next
  layer.style.cursor = next
}

function applyMode(): void {
  if (!layer) return
  layer.style.pointerEvents = enabled && mode !== 'off' ? 'auto' : 'none'
  shownCursor = ''
  updateCursor()
}

let lastHistory = ''
/** 元に戻す／やり直すができるかを main（ツールバーのボタン）へ知らせる。変わったときだけ */
function reportHistory(): void {
  const history = { canUndo: canUndoShapes(shapes), canRedo: canRedoShapes(shapes) }
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

/** つかめる距離(px)。四角は枠の線、手書きの線はその線からこの距離まで */
const GRAB_TOLERANCE = 6
/** 描いた形の一覧と、元に戻す／やり直すの手順 */
let shapes: ShapeState = emptyShapes()
let shapeKey = 0
/** 記録の ID。動かす・戻すたびに新しくする（操作ログは追記のみ。前の ID は replaces で指す） */
const newId = (): string => `p${++seq}-${DOC_TAG}`

/** 描いている途中の形。描き始めのモードで決まり、途中で道具を変えても変わらない */
let draft: Shape | null = null
/** つかんで動かしている形 */
let grab: { key: number; startX: number; startY: number; dx: number; dy: number; startedAt: number } | null = null
let rectStartX = 0
let rectStartY = 0
let rectEndX = 0
let rectEndY = 0
let strokeStart = 0

function onPointerDown(event: PointerEvent): void {
  // 重ねた層はページの DOM の中にあるので、ページのスクリプトが合成の pointer イベントを送れる。人の操作だけで描く
  if (!enabled || mode === 'off' || !ctx || !event.isTrusted) return
  event.preventDefault()
  event.stopPropagation()
  if (autoClearTimer !== null) {
    window.clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
  const x = event.clientX
  const y = event.clientY
  strokeStart = Date.now()
  // 形の線の近くならつかむ。四角の内側の空いたところは、今までどおり新しく描く
  const hit = grabShapeAt(shapes, x, y, GRAB_TOLERANCE)
  if (hit) {
    grab = { key: hit.key, startX: x, startY: y, dx: 0, dy: 0, startedAt: strokeStart }
    updateCursor(x, y)
  } else if (mode === 'rect') {
    rectStartX = rectEndX = x
    rectStartY = rectEndY = y
    draft = { key: 0, id: '', color, kind: 'rect', rect: [x, y, 0, 0] }
  } else {
    draft = { key: 0, id: '', color, kind: 'pen', points: [[x, y]] }
  }
  layer?.setPointerCapture(event.pointerId)
  redraw()
}

function onPointerMove(event: PointerEvent): void {
  if (!event.isTrusted) return
  const x = event.clientX
  const y = event.clientY
  if (grab) {
    event.preventDefault()
    grab.dx = x - grab.startX
    grab.dy = y - grab.startY
    redraw()
    return
  }
  if (draft) {
    event.preventDefault()
    if (draft.kind === 'rect') {
      rectEndX = x
      rectEndY = y
      draft = { ...draft, rect: rectFromDrag(rectStartX, rectStartY, x, y, 0) ?? [rectStartX, rectStartY, 0, 0] }
    } else {
      draft.points.push([x, y])
    }
    redraw()
    return
  }
  updateCursor(x, y)
}

function onPointerUp(event: PointerEvent): void {
  if (!event.isTrusted || (!draft && !grab)) return
  if (layer?.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId)
  finishPointer()
  updateCursor(event.clientX, event.clientY)
}

/** 描いている形・動かしている形を確定して送る（指を離したとき・ページを離れるとき） */
function finishPointer(): void {
  if (grab) {
    const { key, dx, dy, startedAt } = grab
    grab = null
    // ほとんど動いていなければ、ただのクリック（1手にしない）
    const change = Math.abs(dx) < 2 && Math.abs(dy) < 2 ? null : moveShape(shapes, key, Math.round(dx), Math.round(dy), newId())
    if (change) apply(change, startedAt)
    else redraw()
    return
  }
  let drawn = draft
  draft = null
  if (!drawn) return
  if (drawn.kind === 'rect') {
    const box = rectFromDrag(rectStartX, rectStartY, rectEndX, rectEndY)
    if (!box) {
      // クリックだけ（枠にならない）。描きかけを消し、記録にも残さない
      redraw()
      return
    }
    drawn = { ...drawn, rect: box }
  }
  apply(addShape(shapes, { ...drawn, key: ++shapeKey, id: newId() }), strokeStart)
}

/** 一覧を変えた結果を画面に描き、記録へ送る（操作ログは追記のみ） */
function apply(change: ShapeChange, atStart = Date.now()): void {
  shapes = change.state
  redraw()
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
  if (shapes.shapes.length > 0) armSafetyClear()
  else if (autoClearTimer !== null) {
    window.clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
  reportHistory()
}

/** 一つ前に戻す・やり直す。描いている途中や、戻すものが無いときは false */
function undo(): boolean {
  if (draft || grab) return false
  const change = undoShapes(shapes, newId)
  if (!change) return false
  apply(change)
  return true
}

function redo(): boolean {
  if (draft || grab) return false
  const change = redoShapes(shapes, newId)
  if (!change) return false
  apply(change)
  return true
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
