import { useCallback, useRef, useState } from 'react'
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '@shared/types'
import { useT } from '../lib/i18n'

/**
 * 2つの領域の境界。ドラッグで比率を変える。
 * orientation が vertical なら左右（幅）、horizontal なら上下（高さ）を分ける。
 * ポインターイベントでマウス・トラックパッド・ペンを同じコードで扱う（OS差を作らない）。
 * キーボードでも動かせるようにして、ドラッグできない環境でも操作可能にする。
 *
 * ⚠ 内蔵ブラウザ（WebContentsView）はDOMの上に重なるネイティブのビューで、ポインターが
 * その上に入ると renderer にイベントが届かず、ドラッグが途切れる（setPointerCapture も効かない）。
 * そこでドラッグ中は onDragChange で知らせ、App 側でビューを一時的に隠してもらう。
 */
export function Splitter({
  ratio,
  onChange,
  onCommit,
  orientation = 'vertical',
  reverse = false,
  onDragChange
}: {
  ratio: number
  onChange: (ratio: number) => void
  onCommit: (ratio: number) => void
  /** vertical … 縦の線で左右を分ける / horizontal … 横の線で上下を分ける */
  orientation?: 'vertical' | 'horizontal'
  /** 比率の領域が後ろ側（右・下）にあるとき true。ターミナルを左・上に置いたときに使う */
  reverse?: boolean
  /** ドラッグの開始・終了。ドラッグ中は内蔵ブラウザのビューを隠してもらう */
  onDragChange?: (dragging: boolean) => void
}) {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const latest = useRef(ratio)
  latest.current = ratio
  const vertical = orientation === 'vertical'

  const clamp = (value: number) => Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value))

  // Orca由来: ~/bench/orca/src/renderer/src/components/tab-group/TabGroupSplitLayout.tsx（MIT）
  // 縦横共通の比率計算・ドラッグ中の外枠の測り直し・別の指を無視する扱いを移植
  const handleDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) return
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      setDragging(true)
      onDragChange?.(true)
      // ドラッグ中はどこにポインターがあってもリサイズのカーソルにし、文字選択を止める
      document.body.dataset.resizing = vertical ? 'col' : 'row'
      // pointermove の中では測らない。外枠が動いたとき（ウィンドウのリサイズ）だけ測り直す
      let rect = container.getBoundingClientRect()
      const observer = new ResizeObserver(() => { rect = container.getBoundingClientRect() })
      observer.observe(container)

      const move = (e: PointerEvent) => {
        if (e.pointerId !== event.pointerId) return
        const pos = vertical ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height
        const next = clamp(reverse ? 1 - pos : pos)
        latest.current = next
        onChange(next)
      }
      const up = (e: PointerEvent) => {
        if (e.pointerId !== event.pointerId) return
        observer.disconnect()
        setDragging(false)
        onDragChange?.(false)
        delete document.body.dataset.resizing
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        onCommit(latest.current)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [onChange, onCommit, onDragChange, vertical, reverse]
  )

  const handleKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01
    // 矢印の向きに境界が動くよう、比率の領域が後ろ側なら増減を入れ替える
    const [back, forward] = vertical
      ? reverse ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight']
      : reverse ? ['ArrowDown', 'ArrowUp'] : ['ArrowUp', 'ArrowDown']
    if (event.key === back) {
      const next = clamp(ratio - step)
      onChange(next)
      onCommit(next)
    } else if (event.key === forward) {
      const next = clamp(ratio + step)
      onChange(next)
      onCommit(next)
    } else {
      return
    }
    event.preventDefault()
  }

  return (
    <div
      className={`splitter splitter--${orientation}${dragging ? ' splitter--dragging' : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={t('splitter.browserTerminal')}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
      tabIndex={0}
      onPointerDown={handleDown}
      onKeyDown={handleKey}
      data-testid="splitter"
    />
  )
}
