import { contextBridge, ipcRenderer } from 'electron'
import { isPageChange } from '../shared/page'

/** 入力欄の読み上げ名。main が画面の言語で渡す（--ade-annotation-label）。無ければ英語 */
function annotationLabel(): string {
  const arg = process.argv.find((a) => a.startsWith('--ade-annotation-label='))
  try {
    return arg ? decodeURIComponent(arg.slice('--ade-annotation-label='.length)) : 'Comment on the screen'
  } catch {
    return 'Comment on the screen'
  }
}

/**
 * レビュー対象のページへ入れる注入スクリプト（設計4章「ペン・テキスト」）。

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
  ready: 'ade-review:ready'
} as const

type PenMode = 'off' | 'pen' | 'text'

interface Command {
  /**
   * leave  … SPA でページが変わった。入力中の文と描きかけの線を確定し、left を返す
   * commit … 別のドキュメントへ移る直前。入力中の文と描きかけの線を確定するだけ
   */
  type: 'mode' | 'clear' | 'enable' | 'disable' | 'config' | 'leave' | 'commit'
  mode?: PenMode
  /** clear のとき、入力中の吹き出しも含めてすべて消す（ページが変わったとき） */
  page?: boolean
  /** 消し忘れの保険の上限(ms)。0 以下で保険なし */
  maxHoldMs?: number
}

/** main へ送る操作ログ。時刻は epoch ms で送り、main が録画時計へ直す */
interface RawEvent {
  at: number
  /** draft は入力中の吹き出しの画面を main に控えてもらう合図（操作ログには残さない） */
  type: 'click' | 'scroll' | 'pen' | 'text' | 'pointer' | 'left' | 'draft'
  [key: string]: unknown
}

/*
 * 書き込みの見た目。白いページでも暗いページでも読めるよう、
 * ローズの線の下に白い縁を敷く（ADE のペンの色。tokens.css の --brand-rose 系）。
 */
const PEN_COLOR = '#ff2d78'
const PEN_HALO = 'rgba(255, 255, 255, 0.9)'
const PEN_WIDTH = 4
const PEN_HALO_WIDTH = PEN_WIDTH + 4
const BUBBLE_BACKGROUND = 'linear-gradient(135deg, #ff2d78, #8b5cf6)'
const BUBBLE_SHADOW = '0 0 0 2px rgba(255, 255, 255, 0.95), 0 8px 22px rgba(255, 45, 120, 0.35)'
/** ペンのカーソル。ローズの点に白い縁（中心が描く位置）。読めない環境では crosshair */
const PEN_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E" +
  "%3Ccircle cx='10' cy='10' r='5' fill='%23ff2d78' stroke='white' stroke-width='2'/%3E%3C/svg%3E\") 10 10, crosshair"
/**
 * 消し忘れの保険（ms）。
 *
 * 線とテキストは本来、main からの `clear` 指示で消す（＝発話の区切り。設計4章）。
 * 指示が来ないまま残り続けると画面共有に写りっぱなしになるので、上限を置く。
 */
const DEFAULT_MAX_HOLD_MS = 30_000

let enabled = false
let mode: PenMode = 'off'
let seq = 0
/**
 * このドキュメントの印。書き込みの ID（p1・x1）はページを読み直すたびに 1 から振り直されるので、
 * 1本の録画の中で対象を切り替えると別のページの書き込みと ID が重なり、静止画を取り違える。
 * ID の後ろにこの印を付けて、録画全体で重ならないようにする。
 */
const DOC_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

let maxHoldMs = DEFAULT_MAX_HOLD_MS
let layer: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let textLayer: HTMLDivElement | null = null
let autoClearTimer: number | null = null
/** ページが変わったのに main から消す指示が来ないときの保険 */
let leaveTimer: number | null = null
/** 入力中の吹き出しを確定する関数。ページを離れる前に呼んで、書きかけの文を失わない */
const pendingCommits = new Map<HTMLElement, (leaving?: boolean) => void>()

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
  return parts.join(' > ')
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

  const texts = document.createElement('div')
  texts.style.position = 'absolute'
  texts.style.left = '0px'
  texts.style.top = '0px'
  texts.style.width = '100%'
  texts.style.height = '100%'
  root.append(texts)

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
  textLayer = texts
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
  ctx.strokeStyle = PEN_COLOR
  ctx.lineWidth = PEN_WIDTH
}

/** いま描いている線を、白い縁 → ローズの順で描き直す */
function strokeCurrent(): void {
  if (!ctx) return
  ctx.strokeStyle = PEN_HALO
  ctx.lineWidth = PEN_HALO_WIDTH
  ctx.stroke()
  ctx.strokeStyle = PEN_COLOR
  ctx.lineWidth = PEN_WIDTH
  ctx.stroke()
}

function clearAll(keepEditing = false): void {
  if (ctx && canvas) {
    const ratio = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio)
  }
  // 区切りで消すときも入力中の吹き出しは残す（書きかけの文を失わない。動かすと焦点が外れるので触らない）
  for (const child of Array.from(textLayer?.children ?? [])) {
    if (!keepEditing || (child as HTMLElement).contentEditable !== 'true') child.remove()
  }
  if (autoClearTimer !== null) {
    window.clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
  if (!keepEditing) pendingCommits.clear()
}

/**
 * ページを離れる前に、入力中の文と描きかけの線を確定して main へ送る。
 * 書き込みはその画面だけのもの（新しいページへ引き継がない）だが、記録からは失わない。
 */
function commitPending(leaving = false): void {
  for (const commit of Array.from(pendingCommits.values())) commit(leaving)
  pendingCommits.clear()
  if (drawing) finishStroke()
}

/**
 * 消し忘れの保険を張り直す。
 * 通常は main から `clear` が来て消える。来なかったときだけここで消す。
 */
function armSafetyClear(): void {
  if (autoClearTimer !== null) window.clearTimeout(autoClearTimer)
  autoClearTimer = null
  if (maxHoldMs > 0) autoClearTimer = window.setTimeout(() => clearAll(true), maxHoldMs)
}

function applyMode(): void {
  if (!layer) return
  layer.style.pointerEvents = enabled && mode !== 'off' ? 'auto' : 'none'
  layer.style.cursor = mode === 'pen' ? PEN_CURSOR : mode === 'text' ? 'text' : 'auto'
}

// ───────────────────────── ペン ─────────────────────────

let drawing = false
let strokeStart = 0
let minX = 0
let minY = 0
let maxX = 0
let maxY = 0

function onPointerDown(event: PointerEvent): void {
  if (!enabled) return
  if (mode === 'text') {
    event.preventDefault()
    event.stopPropagation()
    try {
      placeText(event.clientX, event.clientY)
    } catch (err) {
      send({ at: Date.now(), type: 'text', id: 'error', x: 0, y: 0, body: '', error: String(err) })
    }
    return
  }
  if (mode !== 'pen' || !ctx) return
  event.preventDefault()
  event.stopPropagation()
  drawing = true
  strokeStart = Date.now()
  minX = maxX = event.clientX
  minY = maxY = event.clientY
  if (autoClearTimer !== null) {
    window.clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
  ctx.beginPath()
  ctx.moveTo(event.clientX, event.clientY)
  layer?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!drawing || !ctx) return
  event.preventDefault()
  ctx.lineTo(event.clientX, event.clientY)
  strokeCurrent()
  minX = Math.min(minX, event.clientX)
  minY = Math.min(minY, event.clientY)
  maxX = Math.max(maxX, event.clientX)
  maxY = Math.max(maxY, event.clientY)
}

function onPointerUp(event: PointerEvent): void {
  if (!drawing) return
  if (layer?.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId)
  finishStroke()
}

/** 描いている線を確定して送る（指を離したとき・ページを離れるとき） */
function finishStroke(): void {
  if (!drawing) return
  drawing = false
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  send({
    at: Date.now(),
    atStart: strokeStart,
    type: 'pen',
    id: `p${++seq}-${DOC_TAG}`,
    bbox: [Math.round(minX), Math.round(minY), Math.round(maxX - minX), Math.round(maxY - minY)],
    el: describe(centerX, centerY)
  })
  armSafetyClear()
}

// ───────────────────────── テキスト ─────────────────────────

/** 吹き出しの最大の大きさ。行数は 160px から上下の余白を引いて 15px×1.45 の行で割った数 */
const BUBBLE_MAX_WIDTH = 320
const BUBBLE_MAX_HEIGHT = 160
const BUBBLE_MAX_LINES = 6

function placeText(x: number, y: number): void {
  if (!textLayer) return
  const input = document.createElement('div')
  // 'plaintext-only' は環境によっては代入で例外になる。確実な 'true' を使い、
  // 書式は commit 時に textContent を取ることで落とす
  input.contentEditable = 'true'
  input.setAttribute('data-ade-text-input', '')
  input.setAttribute('role', 'textbox')
  input.setAttribute('aria-label', annotationLabel())
  input.spellcheck = false
  input.style.position = 'absolute'
  input.style.left = `${x}px`
  input.style.top = `${y}px`
  // 長文でもページを覆わないよう、吹き出しの大きさを抑える。全文は保存データと指摘に残る
  input.style.maxWidth = `${BUBBLE_MAX_WIDTH}px`
  input.style.maxHeight = `${BUBBLE_MAX_HEIGHT}px`
  input.style.overflowY = 'auto'
  input.style.minWidth = '160px'
  input.style.minHeight = '1.45em'
  input.style.padding = '7px 12px'
  // 押した点を指す吹き出し。左上の角だけ尖らせる
  input.style.borderRadius = '4px 14px 14px 14px'
  input.style.backgroundImage = BUBBLE_BACKGROUND
  input.style.backgroundColor = PEN_COLOR
  input.style.boxShadow = BUBBLE_SHADOW
  input.style.color = '#ffffff'
  input.style.caretColor = '#ffffff'
  input.style.font = '600 15px system-ui, -apple-system, "Hiragino Sans", sans-serif'
  input.style.lineHeight = '1.45'
  input.style.letterSpacing = '0.01em'
  input.style.textShadow = '0 1px 1px rgba(0, 0, 0, 0.18)'
  input.style.boxSizing = 'border-box'
  input.style.whiteSpace = 'pre-wrap'
  input.style.pointerEvents = 'auto'
  input.style.outline = 'none'
  textLayer.append(input)
  input.focus()
  // ID は置いた時点で決める。入力中に控えた画面（draft）と、確定した書き込みを結びつけるため
  const id = `x${++seq}-${DOC_TAG}`

  /** @param leaving ページを離れるために確定した。静止画は入力中に控えた画面を使う */
  const commit = (leaving = false): void => {
    if (!pendingCommits.delete(input)) return
    const body = (input.textContent ?? '').trim()
    if (!body) {
      input.remove()
      return
    }
    input.contentEditable = 'false'
    // 入力中だけ幅を確保していた。確定後は文字の幅に合わせる
    input.style.minWidth = '0px'
    // 確定後は収まらない分を「…」で省く（スクロールさせない）
    // 入力中に末尾まで送られていても、確定後は書き出しから見せる
    input.scrollTop = 0
    // 内側の余白にはみ出す行も描かない（hidden は余白の外側で切るため、次の行が覗く）
    input.style.overflow = 'clip'
    input.style.setProperty('overflow-clip-margin', 'content-box')
    input.style.display = '-webkit-box'
    input.style.setProperty('-webkit-box-orient', 'vertical')
    input.style.setProperty('-webkit-line-clamp', String(BUBBLE_MAX_LINES))
    send({
      at: Date.now(),
      type: 'text',
      id,
      x: Math.round(x),
      y: Math.round(y),
      body,
      el: describe(x, y),
      ...(leaving ? { leaving: true } : {})
    })
    armSafetyClear()
  }

  pendingCommits.set(input, commit)
  input.addEventListener('blur', () => commit())
  /*
   * 入力が止まるたびに、いまの画面を main に控えてもらう。
   * SPA の遷移は pushState の直後に新しい画面へ描き変わるので、離れる時点で撮っては間に合わない。
   * 書きかけのままページが変わったときは、この控えを指摘の画像にする（前のページの上の文字が写る）。
   */
  let draftTimer: number | null = null
  input.addEventListener('input', () => {
    if (draftTimer !== null) window.clearTimeout(draftTimer)
    draftTimer = window.setTimeout(() => {
      draftTimer = null
      if (pendingCommits.has(input)) send({ at: Date.now(), type: 'draft', id })
    }, 200)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      pendingCommits.delete(input)
      input.remove()
      event.stopPropagation()
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      input.blur()
    }
  })
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
    if (!enabled || now - lastPointer < 100) return
    lastPointer = now
    send({ at: now, type: 'pointer', x: event.clientX, y: event.clientY })
  }, { passive: true })

  // ページ側の操作は捕捉のみ（止めない）
  document.addEventListener(
    'click',
    (event) => {
      if (!enabled || mode !== 'off') return
      send({
        at: Date.now(),
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
      if (!enabled) return
      // 吹き出しの中のスクロール（長文の入力）はページのスクロールではない
      if (event.target instanceof Element && event.target.closest('[data-ade-text-input]')) return
      // スクロールで線とテキストは消える（設計4章）。長文の入力で画面が送られても、書きかけの文は残す
      clearAll(true)
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
      // 発話の区切り（SilenceSegmenter の区切り）で main から呼ばれる。
      // page はページが変わったとき。入力中の吹き出しも含めて消し、新しいページへ持ち越さない
      clearAll(!command.page)
      break
    case 'commit':
      commitPending()
      break
    case 'leave':
      // 直前の通知（beforeLeave）で確定済みのことが多い。残っていれば控えた画面で確定する
      commitPending(true)
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
 * 新しい画面に描き変わる「前」に捕まえて、入力中の文と描きかけの線を確定する。
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
  if (enabled && changed) commitPending(true)
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
  if (typeof next === 'string') beforeLeave(next)
})
// 戻る・進む・ハッシュの変化は URL が変わった直後、ページ側の描き変え（ルーターの処理）より前に届く。
// この preload はページのスクリプトより先に登録するので、ルーターより先に呼ばれる
window.addEventListener('popstate', () => beforeLeave(window.location.href))
window.addEventListener('hashchange', (event) => beforeLeave(event.newURL))

// Option/Altを押している間だけ描く。入力中は文字入力を優先する。
let heldMode: PenMode | null = null
window.addEventListener('keydown', (event) => {
  const target = event.target
  const editing = target instanceof Element && target.closest('input,textarea,[contenteditable]')
  if (!enabled || event.key !== 'Alt' || event.repeat || editing) return
  heldMode = mode
  mode = 'pen'
  applyMode()
  event.preventDefault()
}, true)
function releaseHeldPen(): void {
  if (heldMode === null) return
  mode = heldMode
  heldMode = null
  drawing = false
  applyMode()
}
window.addEventListener('keyup', (event) => { if (event.key === 'Alt') releaseHeldPen() }, true)
window.addEventListener('blur', releaseHeldPen)
