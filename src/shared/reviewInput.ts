/**
 * 注入スクリプト（preload/review.ts）が、ページの入力を記録してよいかを決める純粋な処理。
 * レビュー対象は任意のページなので、ページのスクリプトが起こした合成の入力（isTrusted でないもの）は記録しない。
 */

/** 続けて届いたクリックをまとめる間隔(ms)と距離(px)。ダブルクリックや連打を1件にする */
const CLICK_MERGE_MS = 250
const CLICK_MERGE_PX = 4

interface ClickInput {
  isTrusted: boolean
  clientX: number
  clientY: number
}

export interface LastClick {
  at: number
  x: number
  y: number
}

/** 記録するクリックなら、次の比較に使う「直前のクリック」を返す。記録しないなら null */
export function acceptClick(event: ClickInput, last: LastClick | null, now: number): LastClick | null {
  if (!event.isTrusted) return null
  if (last) {
    const near = Math.abs(event.clientX - last.x) <= CLICK_MERGE_PX && Math.abs(event.clientY - last.y) <= CLICK_MERGE_PX
    if (near && now - last.at < CLICK_MERGE_MS) return null
  }
  return { at: now, x: event.clientX, y: event.clientY }
}

/**
 * ページの世界から届いた「遷移の直前」の知らせ（ade-review:before-navigate）を使ってよいか。
 * pushState は同じオリジンの URL しか受け付けないので、それ以外はページが勝手に送った値として捨てる
 */
export function isSameOriginNavigation(next: string, current: string): boolean {
  try {
    return new URL(next).origin === new URL(current).origin
  } catch {
    return false
  }
}
