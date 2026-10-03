import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 上に開くポップオーバー。
 * ステータスバーは overflow を切っているので、body へ出して固定位置で置く。
 * ⚠ 内蔵ブラウザのビューはDOMの上に重なるため、開いている間は App 側でビューを隠す（onOpenChange）。
 */
export function StatusPopover({ anchor, label, onClose, className, children }: {
  anchor: HTMLElement | null
  /** 幅などを足すときのクラス（.sb-pop--wide） */
  className?: string
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const w = ref.current.offsetWidth
    const footerTop = anchor.closest('.statusbar')?.getBoundingClientRect().top ?? a.top
    setPos({ left: Math.max(8, Math.min(a.left, window.innerWidth - w - 8)), bottom: window.innerHeight - footerTop + 6 })
  }, [anchor])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); anchor?.focus() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [anchor, onClose])

  return createPortal(
    <div ref={ref} className={`sb-pop${className ? ` ${className}` : ''}`} role="dialog" aria-label={label} data-testid="statusbar-popover"
      style={pos ? { left: pos.left, bottom: pos.bottom } : { visibility: 'hidden' }}>
      {children}
    </div>,
    document.body
  )
}
