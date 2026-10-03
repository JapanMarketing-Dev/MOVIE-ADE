import { useRef, useState, type ReactNode } from 'react'

/**
 * ツールチップ。
 *
 * ⚠ 内蔵ブラウザ（WebContentsView）はネイティブのビューで、DOMの上に必ず重なる。
 * ビューの領域へはみ出したツールチップは隠れて見えない。
 * そのため `side` で開く向きを呼び出し側が決める:
 *   - 上部バー       … 'bottom'（下はブラウザのツールバー＝DOMなので見える）
 *   - ブラウザのツールバー … 'top'（下はビュー。上の上部バーへ開く）
 *   - フィードバックモード … 使わない。ツールバーが最上段で逃げ場が無いうえ、
 *     画面共有に出る画面なので、OS標準の title に任せる（MODE-2 / NF-13）
 */
export function Tooltip({
  label,
  shortcut,
  side = 'bottom',
  children
}: {
  label: string
  /** ショートカットの表記。formatShortcut() で作ったものを渡す */
  shortcut?: string
  side?: 'top' | 'bottom'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)

  const show = () => {
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      setOpen(true)
    }, 320)
  }

  const hide = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    setOpen(false)
  }

  return (
    <span
      className="tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      <span className={`tooltip tooltip--${side}${open ? ' is-open' : ''}`} role="tooltip">
        {label}
        {shortcut != null && <kbd className="tooltip__key">{shortcut}</kbd>}
      </span>
    </span>
  )
}
