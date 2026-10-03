/** 画像のビューアの拡大率（React に依存しない。単体テストから呼ぶ） */

export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 16] as const
export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/** 画面に合わせたときの拡大率。小さい画像は引き伸ばさない（1 まで） */
export function fitZoom(natural: { width: number; height: number }, box: { width: number; height: number }): number {
  if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return 1
  return Math.min(1, box.width / natural.width, box.height / natural.height)
}

/** 今の拡大率から一段だけ大きく（direction = 1）・小さく（-1）。段の間にいるときは次の段へ */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? MAX_ZOOM
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6) ?? MIN_ZOOM
}

/** ⌘/Ctrl + ホイール・ピンチ。deltaY に比例して滑らかに変える */
export function wheelZoom(current: number, deltaY: number): number {
  const next = current * Math.exp(-deltaY * 0.01)
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
}
