/**
 * 文字で指摘（エディタの内蔵ブラウザ・映したウインドウの上で、枠を引いて指示を打つ）。
 * 録画しないで指摘を1件足す。注入スクリプト（preload/review.ts）・main・renderer から使うので Electron に依存しない。
 */

/** 1件の指示の長さの上限（main でも切る） */
export const MAX_NOTE_TEXT = 2000
/** 見出しにする1行目の長さ */
export const NOTE_TITLE_CHARS = 40
/** 書き込みの ID・静止画の印の頭（録画のペンの ID と見分ける。整理のときに録画の素材から外す） */
export const NOTE_ID_PREFIX = 'note-'

/** 注入スクリプトと main のあいだのチャネル（ade-review:* と同じ並び） */
export const NOTE_CHANNELS = {
  /** 注入側 → main。打った指示（枠・要素・文） */
  submit: 'ade-review:note',
  /** 注入側 → main。描いていないときの Esc（文字で指摘をやめる） */
  exit: 'ade-review:note-exit'
} as const

/** 文字で指摘の欄でのキーの扱い */
export type NoteKeyAction = 'submit' | 'cancel' | 'newline' | null

/**
 * 欄のキー。Enter で足す・Shift+Enter で改行・Esc で取り消す。
 * IME の変換中（isComposing・keyCode 229）は何もしない（変換を確定した Enter で送らない）
 */
export function noteKeyAction(event: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): NoteKeyAction {
  if (event.isComposing || event.keyCode === 229) return null
  if (event.key === 'Escape') return 'cancel'
  if (event.key !== 'Enter') return null
  if (event.shiftKey || event.altKey) return 'newline'
  return 'submit'
}

/** 指示の文を整える（前後の空白を落とし、上限で切る）。空なら null */
export function normalizeNoteText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_NOTE_TEXT).trim()
  return text ? text : null
}

/** 見出し。最初の空でない行を NOTE_TITLE_CHARS で切る */
export function noteTitle(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? ''
  const chars = Array.from(line)
  return chars.length <= NOTE_TITLE_CHARS ? line : `${chars.slice(0, NOTE_TITLE_CHARS).join('')}…`
}

type Box = [number, number, number, number]

/**
 * クリックだけ（ドラッグしていない）ときの枠。指した要素がほどよい大きさならその要素を囲み、
 * 大きすぎる（ページ全体・映した映像）・無いときはクリックした所に小さな枠を置く。枠はビューの中に収める
 */
export function noteBoxFromClick(x: number, y: number, view: { width: number; height: number }, element?: { x: number; y: number; width: number; height: number } | null): Box {
  const clamp = (box: Box): Box => {
    const left = Math.max(0, Math.min(box[0], view.width - 1))
    const top = Math.max(0, Math.min(box[1], view.height - 1))
    const right = Math.max(left + 1, Math.min(box[0] + box[2], view.width))
    const bottom = Math.max(top + 1, Math.min(box[1] + box[3], view.height))
    return [Math.round(left), Math.round(top), Math.round(right - left), Math.round(bottom - top)]
  }
  if (element && element.width >= 8 && element.height >= 8 && element.width * element.height <= view.width * view.height * 0.6) {
    return clamp([element.x - 3, element.y - 3, element.width + 6, element.height + 6])
  }
  const w = Math.min(160, view.width)
  const h = Math.min(100, view.height)
  return clamp([x - w / 2, y - h / 2, w, h])
}

/** 欄を枠の下（入らなければ上、どちらも無理なら枠の中の上端）に置く位置 */
export function noteEditorPosition(box: Box, view: { width: number; height: number }, size: { width: number; height: number }): { left: number; top: number } {
  const [x, y, , h] = box
  const gap = 8
  const left = Math.max(8, Math.min(x, view.width - size.width - 8))
  if (y + h + gap + size.height <= view.height) return { left, top: y + h + gap }
  if (y - gap - size.height >= 0) return { left, top: y - gap - size.height }
  return { left, top: Math.max(8, Math.min(y + gap, view.height - size.height - 8)) }
}
