/**
 * 録画中の書き込み（ペン・四角の枠）の道具と色。
 * main・renderer・注入スクリプト（preload/review.ts）から使うので Electron に依存しない。
 */

/** 書き込みの道具。pen は手書きの線、rect はドラッグで囲む四角の枠 */
export type AnnotationShape = 'pen' | 'rect'

/**
 * 書き込みの色。商談や社外の会議でも使えるよう、目立つ色に加えて落ち着いた色（青・黒）も置く。
 * どの色も白い縁を敷いて描くので、暗いページでも読める。
 */
export const ANNOTATION_COLORS = {
  rose: '#ff2d78',
  red: '#e5484d',
  amber: '#f5a524',
  green: '#30a46c',
  blue: '#2f6fed',
  black: '#1f2328'
} as const

export type AnnotationColor = keyof typeof ANNOTATION_COLORS

export const ANNOTATION_COLOR_IDS = Object.keys(ANNOTATION_COLORS) as AnnotationColor[]

export const DEFAULT_ANNOTATION_COLOR: AnnotationColor = 'rose'

export function isAnnotationColor(value: unknown): value is AnnotationColor {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ANNOTATION_COLORS, value)
}

/** 知らない値は既定の色にする（settings.json の手書きや古い版の値） */
export function normalizeAnnotationColor(value: unknown): AnnotationColor {
  return isAnnotationColor(value) ? value : DEFAULT_ANNOTATION_COLOR
}

/**
 * ドラッグの始点と終点から四角の枠を作る（どの向きにドラッグしても x, y が左上になる）。
 * 小さすぎる枠（クリックの手ぶれ）は null。
 */
export function rectFromDrag(x0: number, y0: number, x1: number, y1: number, minSize = 4): [number, number, number, number] | null {
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  const w = Math.abs(x1 - x0)
  const h = Math.abs(y1 - y0)
  if (w < minSize && h < minSize) return null
  return [x, y, w, h]
}

/** 色の候補を順に回したときの次の色（C キー） */
export function nextAnnotationColor(color: AnnotationColor): AnnotationColor {
  const index = ANNOTATION_COLOR_IDS.indexOf(color)
  return ANNOTATION_COLOR_IDS[(index + 1) % ANNOTATION_COLOR_IDS.length]!
}

/**
 * 録画中の書き込みのショートカット。
 * pen … P / rect … B か R / off … V か Esc（ページを操作する）/ color … C（次の色）/ undo … ⌘Z・Ctrl+Z / redo … ⌘⇧Z・Ctrl+Shift+Z・Ctrl+Y
 */
export type AnnotationKeyAction = 'pen' | 'rect' | 'off' | 'color' | 'undo' | 'redo'

export interface AnnotationKeyInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** キーに対応する操作。対応しないキーは null。入力欄で打っているかどうかは呼び出し側で見る */
export function annotationKeyAction(input: AnnotationKeyInput, mac: boolean): AnnotationKeyAction | null {
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  const mod = mac ? input.metaKey && !input.ctrlKey : input.ctrlKey && !input.metaKey
  if (mod && !input.altKey) {
    if (key === 'z') return input.shiftKey ? 'redo' : 'undo'
    if (key === 'y' && !mac && !input.shiftKey) return 'redo'
    return null
  }
  // 文字のキーは修飾キー無しのときだけ（⌘P・Ctrl+C などアプリやページのショートカットを奪わない）
  if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey) return null
  switch (key) {
    case 'p': return 'pen'
    case 'b':
    case 'r': return 'rect'
    case 'v':
    case 'Escape': return 'off'
    case 'c': return 'color'
    default: return null
  }
}

/**
 * ツールバーで選んだ道具から、注入スクリプトのモードを決める。
 * none は「ブラウザを操作」（矢印の道具）。書き込みなしで、ページを素通しで操作できる
 */
export function annotationModeForTool(tool: 'none' | AnnotationShape): 'off' | AnnotationShape {
  return tool === 'none' ? 'off' : tool
}
