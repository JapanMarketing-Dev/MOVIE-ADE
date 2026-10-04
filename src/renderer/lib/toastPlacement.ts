import type { ViewBounds } from '@shared/types'

/**
 * トーストの置き場所（内蔵ブラウザのビューに隠れない場所）を決める。
 *
 * 内蔵ブラウザ（WebContentsView）は DOM の上に必ず重なるので、z-index では前に出せない。
 * そこで、ビューの外の DOM だけの領域に置く:
 *   1. ビューの右か左に、トーストが入る幅があればそこ（広いほう。同じなら右）
 *   2. 無ければ、ビューの上の帯（タイトルバー・タブ・URL欄）に、最新の1件だけを重ねる
 *   3. 帯も低ければ（フィードバックモードで右パネルを閉じたとき）、ツールバーの案内の枠へ回す（notice）
 * ウインドウの幅を狭めても（1024px など）、どのパネルの配置でも見える。
 *
 * 位置はすべて CSS ピクセル（getBoundingClientRect と同じ座標）。
 */

export const TOAST_GAP = 16
export const TOAST_MAX_WIDTH = 380
/** これより狭いところには置かない（本文が数文字で折り返して読めなくなる） */
export const TOAST_MIN_WIDTH = 180
/** 帯に重ねるときに要る高さ（1件ぶん） */
const TOAST_BAND_MIN_HEIGHT = 64

export type ToastPlacement =
  | { kind: 'side'; side: 'left' | 'right'; offset: number; width: number }
  | { kind: 'band'; width: number; maxHeight: number }
  | { kind: 'notice' }

export function toastPlacement(view: ViewBounds | null, viewport: { width: number; height: number }): ToastPlacement {
  const full = Math.min(TOAST_MAX_WIDTH, viewport.width - TOAST_GAP * 2)
  if (!view || view.width <= 0 || view.height <= 0) return { kind: 'side', side: 'right', offset: TOAST_GAP, width: full }
  const right = viewport.width - (view.x + view.width) - TOAST_GAP * 2
  const left = view.x - TOAST_GAP * 2
  if (Math.max(right, left) >= TOAST_MIN_WIDTH) {
    return right >= left
      ? { kind: 'side', side: 'right', offset: TOAST_GAP, width: Math.min(TOAST_MAX_WIDTH, right) }
      : { kind: 'side', side: 'left', offset: TOAST_GAP, width: Math.min(TOAST_MAX_WIDTH, left) }
  }
  const band = view.y - TOAST_GAP
  if (band >= TOAST_BAND_MIN_HEIGHT) return { kind: 'band', width: full, maxHeight: band - TOAST_GAP / 2 }
  return { kind: 'notice' }
}

// ───────────────────────── ビューの位置（useViewBounds が書く） ─────────────────────────

let current: ViewBounds | null = null
const listeners = new Set<() => void>()

/** 内蔵ブラウザのビューの今の位置。隠しているときは null */
export function setViewBoundsForToasts(bounds: ViewBounds | null): void {
  current = bounds
  for (const listener of listeners) listener()
}

export function getViewBoundsForToasts(): ViewBounds | null {
  return current
}

export function subscribeViewBoundsForToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
