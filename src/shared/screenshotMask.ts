/**
 * フィードバックに添える Ferret の画面の静止画を、公開の Issue に載せる前に塗りつぶす範囲の計算。
 *
 * 画面にはターミナルのユーザー名・パス、プロジェクト名、開いている URL、ファイル名が写りうる。
 * 既定でそれらの領域を黒く塗り、利用者がドラッグで塗る範囲を足せるようにする（描くのは renderer の canvas）。
 * ここは純粋な計算だけ（CSS の座標 → 画像の座標、ドラッグ → 矩形、はみ出しの切り詰め）。単体テストの対象。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/**
 * 既定で塗る領域（DOM のセレクタ）。
 * ターミナル（プロンプトのユーザー名・ホスト名・パス）、サイドバーとタイトルバーのプロジェクト名、URL 欄、
 * ファイルの一覧、フッターのリポジトリ名
 */
export const DEFAULT_MASK_SELECTORS: readonly string[] = [
  '[data-testid="terminal-pane"]',
  '[data-testid="sidebar-project"]',
  '.titlebar__project-name',
  '[data-testid="url-input"]',
  '[data-testid="file-explorer"]',
  '[data-testid="statusbar-github"]'
]

/** 画像の外へはみ出した分を切り、整数にする（隠し漏れが無いよう、外側へ丸める）。空になれば null */
export function clampRect(rect: Rect, bounds: Size): Rect | null {
  const x1 = Math.max(0, Math.floor(rect.x))
  const y1 = Math.max(0, Math.floor(rect.y))
  const x2 = Math.min(bounds.width, Math.ceil(rect.x + rect.width))
  const y2 = Math.min(bounds.height, Math.ceil(rect.y + rect.height))
  if (!(x2 > x1 && y2 > y1)) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * 画面（CSS の px。window.innerWidth × innerHeight）の矩形を、撮った画像の座標へ移す。
 * 画像は Retina で 2 倍になったり、2MB に収めるために縮められたりするので、縦横それぞれの比で掛ける
 */
export function scaleRects(rects: readonly Rect[], viewport: Size, image: Size): Rect[] {
  if (viewport.width <= 0 || viewport.height <= 0) return []
  const sx = image.width / viewport.width
  const sy = image.height / viewport.height
  return rects.flatMap((r) => {
    const scaled = clampRect({ x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy }, image)
    return scaled ? [scaled] : []
  })
}

/** 大きく見せている画像（表示の大きさ）上の点を、画像の座標へ移す */
export function displayToImage(point: { x: number; y: number }, display: Size, image: Size): { x: number; y: number } {
  if (display.width <= 0 || display.height <= 0) return { x: 0, y: 0 }
  return { x: (point.x * image.width) / display.width, y: (point.y * image.height) / display.height }
}

/** ドラッグの始点と終点から矩形を作る（どちら向きに引いても同じ）。小さすぎる（誤クリック）なら null */
export function rectFromDrag(a: { x: number; y: number }, b: { x: number; y: number }, bounds: Size, minSize = 4): Rect | null {
  const rect = clampRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }, bounds)
  return rect && rect.width >= minSize && rect.height >= minSize ? rect : null
}
