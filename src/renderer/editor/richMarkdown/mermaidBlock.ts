import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { isMermaidFence, PREVIEW_ASSET_HOST, PREVIEW_SCHEME } from '@shared/preview'
import { currentTheme, THEME_CHANGE_EVENT } from '../../lib/theme'
import { t } from '@shared/i18n'

/**
 * Markdown の編集画面（リッチな編集）の ```mermaid のコードブロックを、既定で図として出す。
 *
 * - 図は ade-preview://assets/mermaid-block.html を、文書で1つだけの隠した sandbox（allow-scripts だけ）の iframe に入れて描く
 *   （src/main/preview/mermaidBlock.js。securityLevel: 'strict'）。返った SVG は <img>（SVG の画像。スクリプトも外部の読み込みも
 *   動かない）で出す。特権のある renderer の DOM に Mermaid の SVG を差し込まない。図ごとに iframe・Mermaid を持たない
 * - 画面に入ったものだけを描き、描いた結果はソースと配色で覚える。隠した iframe はしばらく使わなければ外す（メモリを返す）
 * - 右上の「コード」でソースを編集する。カーソルがブロックの中にあればコード、外へ出れば図に戻る（矢印で入ったときもコード）。
 *   図をダブルクリックしてもコードへ。書き間違いは赤字の文（文字として出す）と「コードを直す」
 * 保存する Markdown（codec.ts の往復）は変えない。ここは表示だけ
 */

export type MermaidBlockMode = 'diagram' | 'code'

/** コードブロックの言語が Mermaid か（```mermaid / ```mmd） */
export function isMermaidLanguage(language: unknown): boolean {
  return typeof language === 'string' && isMermaidFence(language)
}

/**
 * カーソルの位置が変わったときの表示。中に入ったらコード（図のまま見えない文字を打たせない）、外へ出たら図。
 * 「コード」のボタンで開いた直後（まだ中にカーソルが無い）は、外へ出るまでコードのまま
 */
export function modeForSelection(mode: MermaidBlockMode, inside: boolean, wasInside: boolean): MermaidBlockMode {
  if (inside) return 'code'
  return mode === 'code' && wasInside ? 'diagram' : mode
}

/** 描いた SVG の覚え先の鍵（ソースと配色。FNV-1a） */
export function diagramKey(source: string, theme: string): string {
  let hash = 0x811c9dc5
  const text = `${theme}\n${source}`
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`
}

/** 描いた結果（ソースと配色ごと）。多くなりすぎたら古い順に捨てる */
export type DiagramResult = { ok: true; svg: string } | { ok: false; error: string }
const drawn = new Map<string, Promise<DiagramResult>>()
const DRAWN_LIMIT = 100

const FRAME_URL = `${PREVIEW_SCHEME}://${PREVIEW_ASSET_HOST}/mermaid-block.html`
/** 描き終えてからこの時間、次の図が来なければ隠した iframe を外す（Mermaid を持ったページのメモリを返す） */
const FRAME_IDLE_MS = 60_000

/**
 * 図を描く隠した iframe（文書全体で1つ）。図を頼まれたときに作り、順に描かせ、しばらく使わなければ外す。
 * 描けた SVG は画像（<img src="data:image/svg+xml,…">）として出す。SVG の画像はスクリプトも外部の読み込みも動かさないので、
 * renderer の DOM に SVG を差し込まずに済む
 */
const renderer = (() => {
  let frame: HTMLIFrameElement | null = null
  let ready: Promise<void> | null = null
  let nextId = 1
  let idleTimer: number | undefined
  const pending = new Map<number, (result: DiagramResult) => void>()

  const onMessage = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow) return
    const data = event.data as { type?: unknown; id?: unknown; ok?: unknown; svg?: unknown; error?: unknown } | null
    if (data?.type !== 'ade-mermaid:rendered' || typeof data.id !== 'number') return
    const resolve = pending.get(data.id)
    if (!resolve) return
    pending.delete(data.id)
    resolve(data.ok === true && typeof data.svg === 'string' ? { ok: true, svg: data.svg } : { ok: false, error: typeof data.error === 'string' ? data.error : '' })
    scheduleIdle()
  }

  const scheduleIdle = () => {
    window.clearTimeout(idleTimer)
    if (pending.size > 0) return
    idleTimer = window.setTimeout(() => {
      if (pending.size > 0 || !frame) return
      window.removeEventListener('message', onMessage)
      frame.remove()
      frame = null
      ready = null
    }, FRAME_IDLE_MS)
  }

  const open = (): Promise<void> => {
    if (ready) return ready
    const created = document.createElement('iframe')
    created.setAttribute('sandbox', 'allow-scripts')
    created.setAttribute('aria-hidden', 'true')
    created.tabIndex = -1
    created.className = 'rich-md__mermaid-renderer'
    created.title = t('editor.mermaid.frameTitle')
    frame = created
    window.addEventListener('message', onMessage)
    ready = new Promise((resolve) => {
      const onReady = (event: MessageEvent) => {
        if (event.source !== created.contentWindow || (event.data as { type?: unknown } | null)?.type !== 'ade-mermaid:ready') return
        window.removeEventListener('message', onReady)
        resolve()
      }
      window.addEventListener('message', onReady)
    })
    created.src = FRAME_URL
    document.body.appendChild(created)
    return ready
  }

  return {
    async render(source: string, theme: string): Promise<DiagramResult> {
      window.clearTimeout(idleTimer)
      await open()
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        frame?.contentWindow?.postMessage({ type: 'ade-mermaid:render', id, source, theme }, '*')
      })
    }
  }
})()

/** 同じソースと配色の図は1回だけ描く（描き途中のものも共有する） */
function renderDiagram(source: string, theme: string): Promise<DiagramResult> {
  const key = diagramKey(source, theme)
  const hit = drawn.get(key)
  if (hit) {
    drawn.delete(key)
    drawn.set(key, hit)
    return hit
  }
  const result = renderer.render(source, theme)
  drawn.set(key, result)
  while (drawn.size > DRAWN_LIMIT) drawn.delete(drawn.keys().next().value!)
  return result
}

/** SVG を画像の URL にする */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** ProseMirror の nodeView（codec.ts の LabeledCodeBlock.extend から使う）。Mermaid でないコードブロックは素のまま */
export function codeBlockNodeView(editor: Editor, initial: PmNode, getPos: () => number | undefined) {
  let node = initial
  const mermaid = isMermaidLanguage(node.attrs.language)
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''

  const pre = document.createElement('pre')
  if (language) pre.dataset.language = language
  const code = document.createElement('code')
  if (language) code.className = `language-${language}`
  pre.appendChild(code)
  if (!mermaid) return { dom: pre, contentDOM: code }

  const dom = document.createElement('div')
  dom.className = 'rich-md__mermaid'
  dom.dataset.testid = 'rich-md-mermaid'

  // 右上の切り替え（図 / コード）
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'rich-md__mermaid-toggle'
  toggle.contentEditable = 'false'
  toggle.dataset.testid = 'rich-md-mermaid-toggle'

  // 図（SVG の画像）と、書き間違いのときの文と「コードを直す」。描くのは文書で1つの隠した iframe（renderer）
  const view = document.createElement('div')
  view.className = 'rich-md__mermaid-view'
  view.contentEditable = 'false'
  view.dataset.state = 'pending'
  const image = document.createElement('img')
  image.className = 'rich-md__mermaid-image'
  image.alt = t('editor.mermaid.frameTitle')
  image.draggable = false
  image.dataset.testid = 'rich-md-mermaid-image'
  const error = document.createElement('p')
  error.className = 'rich-md__mermaid-error'
  const fix = document.createElement('button')
  fix.type = 'button'
  fix.className = 'rich-md__mermaid-fix'
  fix.textContent = t('editor.mermaid.fixCode')
  view.append(image, error, fix)
  dom.append(toggle, view, pre)

  let mode: MermaidBlockMode = 'diagram'
  let wasInside = false
  let visible = false
  let shownKey = ''
  let destroyed = false

  const source = () => node.textContent
  const apply = () => {
    dom.dataset.mode = mode
    toggle.textContent = mode === 'diagram' ? t('editor.mermaid.showCode') : t('editor.mermaid.showDiagram')
    toggle.title = toggle.textContent
    if (mode === 'diagram') draw()
  }
  /** 画面に入っていて図の表示のときだけ描く。描き終えた図は画像のまま残す（高さも保つ） */
  const draw = () => {
    if (!visible || mode !== 'diagram') return
    const theme = currentTheme()
    const text = source()
    const key = diagramKey(text, theme)
    if (key === shownKey) return
    shownKey = key
    if (view.dataset.state !== 'ok') view.dataset.state = 'pending'
    void renderDiagram(text, theme).then((result) => {
      // 描いている間に中身・配色が変わった・消えた
      if (destroyed || shownKey !== key) return
      if (result.ok) {
        image.src = svgDataUrl(result.svg)
        error.textContent = ''
        view.dataset.state = 'ok'
      } else {
        // 文は文字として出す（HTML にしない）
        error.textContent = result.error || t('editor.mermaid.fixCode')
        view.dataset.state = 'error'
      }
    })
  }
  /** コードへ切り替えて、カーソルをブロックの先頭に置く */
  const editCode = () => {
    mode = 'code'
    wasInside = false
    apply()
    const pos = getPos()
    if (typeof pos === 'number') editor.chain().focus().setTextSelection(pos + 1).run()
  }

  toggle.addEventListener('mousedown', (event) => event.preventDefault())
  toggle.addEventListener('click', () => {
    if (mode === 'diagram') editCode()
    else {
      mode = 'diagram'
      wasInside = false
      apply()
    }
  })
  fix.addEventListener('click', editCode)
  view.addEventListener('dblclick', editCode)

  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      draw()
    }, { rootMargin: '400px 0px' })
    : null
  if (observer) observer.observe(dom)
  else visible = true

  // カーソルが中に入ったらコード、外へ出たら図
  const onSelection = () => {
    const pos = getPos()
    if (typeof pos !== 'number') return
    const { from, to } = editor.state.selection
    const inside = from > pos && to < pos + node.nodeSize
    const next = modeForSelection(mode, inside, wasInside)
    wasInside = inside
    if (next !== mode) {
      mode = next
      apply()
    }
  }
  editor.on('selectionUpdate', onSelection)
  const onTheme = () => { shownKey = ''; draw() }
  window.addEventListener(THEME_CHANGE_EVENT, onTheme)

  apply()

  return {
    dom,
    contentDOM: code,
    update(next: PmNode) {
      // 言語が変わって Mermaid でなくなったら作り直させる
      if (next.type !== node.type || !isMermaidLanguage(next.attrs.language) || next.attrs.language !== node.attrs.language) return false
      node = next
      if (mode === 'diagram') draw()
      return true
    },
    // 図の中の操作（iframe・ボタン）は ProseMirror に渡さない
    stopEvent(event: Event) {
      return event.target instanceof Element && view.contains(event.target)
    },
    ignoreMutation(mutation: { target: globalThis.Node }) {
      return !code.contains(mutation.target)
    },
    destroy() {
      destroyed = true
      window.removeEventListener(THEME_CHANGE_EVENT, onTheme)
      editor.off('selectionUpdate', onSelection)
      observer?.disconnect()
    }
  }
}
