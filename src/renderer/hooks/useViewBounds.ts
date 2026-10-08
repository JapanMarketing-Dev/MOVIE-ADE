import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewBounds } from '@shared/types'
import { setViewBoundsForToasts } from '../lib/toastPlacement'

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
/** 同じ値でも置き直す間隔（1 秒ごとの測り直しの何回に1回か） */
const HEAL_EVERY = 5

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

  const schedule = useCallback((force?: unknown) => {
    if (!visible) {
      if (lastRef.current === 'hidden') return
      lastRef.current = 'hidden'
      setViewBoundsForToasts(null)
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
      // force（定期の置き直し）は同じ値でも送る。main 側のビューだけがずれたときも戻すため
      if (key === lastRef.current && force !== true) return
      lastRef.current = key
      // トーストはビューに隠れない場所へ置く（toastPlacement.ts）ので、位置を知らせる
      setViewBoundsForToasts(bounds)
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
    /*
     * ResizeObserver は大きさしか見ない。大きさが同じまま位置だけが動く（上のツールバーの高さが変わる・一時的に
     * 違う位置で測った）と、ビューがツールバーに重なったまま残る（録画のツールバーが消えて見えた）。
     * 見せている間は 1 秒ごとに測り、変わったときだけ置き直す。main 側のビューだけがずれた場合も戻すため、
     * HEAL_EVERY 回に1回は同じ値でも送る（毎秒の IPC とビューの置き直しを減らす）
     */
    // 最小化・裏の間は置き直さない（表に戻ったら visibilitychange ですぐ置き直す）
    let tick = 0
    const healer = window.setInterval(() => {
      if (document.hidden) return
      tick += 1
      schedule(tick % HEAL_EVERY === 0)
    }, 1000)
    const onVisible = () => { if (!document.hidden) schedule(true) }
    document.addEventListener('visibilitychange', onVisible)
    const onFocus = () => schedule(true)
    window.addEventListener('focus', onFocus)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('focus', onFocus)
      window.clearInterval(healer)
      document.removeEventListener('visibilitychange', onVisible)
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
