import { ANNOTATION_COLORS, type AnnotationColor } from './annotation'
import { PEN_HALO } from './annotationPaint'
import { MAX_NOTE_TEXT, noteEditorPosition, noteKeyAction } from './textNote'

/**
 * 「文字で指摘」の枠と入力欄（DOM）。アプリの注入スクリプト（preload/review.ts）と、
 * 共有リンクの相手の画面（workers/feedback-share/client）が同じものを使う（同じ見た目と操作にする）。
 *
 * ページを壊さないため、スタイルは `el.style.prop = …` で入れ、`innerHTML`・`<style>` を使わない（ページの CSP に弾かれないように）。
 * Enter で足す・Shift+Enter で改行・Esc で取り消す。IME の変換中の Enter では送らない（textNote.ts の noteKeyAction）。
 * 合成のキー・クリック（isTrusted でないもの）では足さない・取り消さない。
 */

export const NOTE_EDITOR_WIDTH = 300
export const NOTE_EDITOR_HEIGHT = 112

export interface NoteLabels {
  placeholder: string
  hint: string
  add: string
}

/** 枠を描く要素（形と色を変えるときは updateNoteBox） */
export function createNoteBox(doc: Document): HTMLDivElement {
  const box = doc.createElement('div')
  box.style.position = 'absolute'
  box.style.boxSizing = 'border-box'
  box.style.borderRadius = '4px'
  box.style.pointerEvents = 'none'
  box.style.margin = '0px'
  box.style.padding = '0px'
  return box
}

export function updateNoteBox(box: HTMLDivElement, rect: [number, number, number, number], color: AnnotationColor): void {
  box.style.border = `3px solid ${ANNOTATION_COLORS[color]}`
  // 白いページでも暗いページでも見えるよう、白い縁を外側に敷く
  box.style.boxShadow = `0 0 0 2px ${PEN_HALO}`
  box.style.left = `${rect[0]}px`
  box.style.top = `${rect[1]}px`
  box.style.width = `${Math.max(1, rect[2])}px`
  box.style.height = `${Math.max(1, rect[3])}px`
}

export interface NoteEditor {
  panel: HTMLDivElement
  input: HTMLTextAreaElement
}

/**
 * 枠のそばに出す入力欄。view は欄を置ける範囲（ビューの CSS ピクセル）。
 * onSubmit は打った文（前後の空白を落とし、MAX_NOTE_TEXT で切ったもの。空なら呼ばない）
 */
export function createNoteEditor(doc: Document, options: {
  rect: [number, number, number, number]
  view: { width: number; height: number }
  color: AnnotationColor
  labels: NoteLabels
  onSubmit: (text: string) => void
  onCancel: () => void
}): NoteEditor {
  const { color, labels } = options
  const panel = doc.createElement('div')
  panel.style.position = 'absolute'
  panel.style.boxSizing = 'border-box'
  panel.style.width = `${NOTE_EDITOR_WIDTH}px`
  panel.style.padding = '8px'
  panel.style.margin = '0px'
  panel.style.background = '#ffffff'
  panel.style.color = '#1f2328'
  panel.style.border = `2px solid ${ANNOTATION_COLORS[color]}`
  panel.style.borderRadius = '8px'
  panel.style.boxShadow = '0 6px 24px rgba(0, 0, 0, 0.25)'
  panel.style.font = '13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif'
  panel.style.pointerEvents = 'auto'
  panel.style.cursor = 'auto'
  const pos = noteEditorPosition(options.rect, options.view, { width: NOTE_EDITOR_WIDTH, height: NOTE_EDITOR_HEIGHT })
  panel.style.left = `${pos.left}px`
  panel.style.top = `${pos.top}px`

  const input = doc.createElement('textarea')
  input.rows = 3
  input.maxLength = MAX_NOTE_TEXT
  input.placeholder = labels.placeholder
  input.spellcheck = false
  input.style.display = 'block'
  input.style.boxSizing = 'border-box'
  input.style.width = '100%'
  input.style.margin = '0px'
  input.style.padding = '6px'
  input.style.border = '1px solid #d0d7de'
  input.style.borderRadius = '4px'
  input.style.background = '#ffffff'
  input.style.color = '#1f2328'
  input.style.font = 'inherit'
  input.style.resize = 'vertical'
  input.style.outline = 'none'

  const footer = doc.createElement('div')
  footer.style.display = 'flex'
  footer.style.alignItems = 'center'
  footer.style.justifyContent = 'space-between'
  footer.style.gap = '8px'
  footer.style.marginTop = '6px'
  const hint = doc.createElement('span')
  hint.textContent = labels.hint
  hint.style.fontSize = '11px'
  hint.style.color = '#57606a'
  const add = doc.createElement('button')
  add.type = 'button'
  add.textContent = labels.add
  add.style.font = 'inherit'
  add.style.fontSize = '12px'
  add.style.padding = '3px 10px'
  add.style.border = '0px'
  add.style.borderRadius = '4px'
  add.style.background = ANNOTATION_COLORS[color]
  add.style.color = '#ffffff'
  add.style.cursor = 'pointer'

  const submit = (): void => {
    const text = input.value.trim()
    if (!text) {
      input.focus()
      return
    }
    options.onSubmit(text.slice(0, MAX_NOTE_TEXT))
  }
  add.addEventListener('click', (event) => {
    if (!event.isTrusted) return
    event.preventDefault()
    submit()
  })
  footer.append(hint, add)
  panel.append(input, footer)

  input.addEventListener('keydown', (event) => {
    // ページのスクリプトが合成のキーで足したり取り消したりできないようにする
    if (!event.isTrusted) return
    const action = noteKeyAction(event)
    if (action === 'submit') {
      event.preventDefault()
      submit()
    } else if (action === 'cancel') {
      event.preventDefault()
      options.onCancel()
    }
  })
  // 打っている文字・欄の操作をページのショートカットへ渡さない（バブルの段で止める）
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'pointerdown', 'pointerup', 'click', 'wheel'] as const) {
    panel.addEventListener(type, (event) => event.stopPropagation())
  }
  return { panel, input }
}
