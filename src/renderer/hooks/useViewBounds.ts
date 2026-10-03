import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewBounds } from '@shared/types'

/**
 * 内蔵ブラウザ（WebContentsView）を置く領域を実測して main へ渡す。
 *
 * WebContentsView は renderer のDOMとは別のレイヤーに描かれるため、
 * 「どこに置くか」をこちらで測って送らないと位置がずれる。
 * レイアウト変化（分割幅のドラッグ、モード切替、ウィンドウリサイズ）はすべて
 * ここを通るので、測定とIPCは requestAnimationFrame で1フレーム1回にまとめる。
 *
 * `layoutKey` にはレイアウトを決める値（モード・分割幅・表示幅）を連結した文字列を渡す。
 * 戻り値を置き場所の要素の `ref` に渡す。モード切替で要素が入れ替わっても、
 * 新しい要素の位置を測り直すだけで、ビュー自体は作り直さない（ページは再読込されない）。
 */
export function useViewBounds(
  layoutKey: string,
  /**
   * ビューを見せるか。false の間は 0 サイズを送って隠す。
   * 空状態や部品見本をDOMで出すときに使う（ネイティブのビューはDOMの上に
   * 必ず重なるので、隠さないと下に入ったDOMが見えない）。
   */
  visible = true
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const lastRef = useRef<string>('')
  const frameRef = useRef<number | null>(null)

  const schedule = useCallback(() => {
    if (!visible) {
      if (lastRef.current === 'hidden') return
      lastRef.current = 'hidden'
      void window.ade.invoke('browser:setBounds', null)
      return
    }
    if (!node || frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const rect = node.getBoundingClientRect()
      const bounds: ViewBounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
      if (key === lastRef.current) return
      lastRef.current = key
      void window.ade.invoke('browser:setBounds', bounds)
    })
  }, [node, visible])

  useEffect(() => {
    if (!node || !visible) {
      schedule()
      return
    }
    schedule()
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    window.addEventListener('resize', schedule)
    // フォント読み込みなどで後からレイアウトが動く場合に取りこぼさない
    const timer = window.setTimeout(schedule, 150)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.clearTimeout(timer)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [node, visible, schedule])

  // モード・分割幅・表示幅が変わったら、同じフレームで測り直す
  useEffect(() => {
    schedule()
  }, [schedule, layoutKey])

  return setNode
}
