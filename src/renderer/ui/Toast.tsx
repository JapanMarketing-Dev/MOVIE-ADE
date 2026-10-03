import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react'
import { IconButton } from './Button'
import { useT } from '../lib/i18n'

/**
 * トースト。処理の結果を、画面を止めずに知らせる。
 *
 * ⚠ 内蔵ブラウザ（WebContentsView）はDOMの上に重なるので、ビューの領域に出すと
 * 隠れる。右下ではなく **右上のツールバー寄り** に出し、エディタモードでは
 * ターミナル側（DOMだけの領域）の上に重ねる。
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  tone?: ToastTone
  /** 本文。1行で読み切れる長さにする */
  message: string
  /** 補足。原因や次の一手 */
  detail?: string
  /** ミリ秒。0 を渡すと自動で消えない */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
}

const ToastContext = createContext<(options: ToastOptions) => void>(() => {})

/** どこからでも `const toast = useToast()` で呼べる */
export function useToast(): (options: ToastOptions) => void {
  return useContext(ToastContext)
}

const ICONS: Record<ToastTone, ReactNode> = {
  info: <Info size={16} strokeWidth={1.75} />,
  success: <CircleCheck size={16} strokeWidth={1.75} />,
  warning: <TriangleAlert size={16} strokeWidth={1.75} />,
  danger: <CircleX size={16} strokeWidth={1.75} />
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (options: ToastOptions) => {
      const id = ++seq.current
      setItems((prev) => [...prev.slice(-3), { ...options, id }])
      const duration = options.duration ?? 4200
      if (duration > 0) window.setTimeout(() => dismiss(id), duration)
    },
    [dismiss]
  )

  const value = useMemo(() => push, [push])

  /*
   * 設定などのダイアログ（showModal）は最前面の層に出るため、z-index では上に出せない。
   * 置き場所を popover にして、知らせが増えるたびに出し直し、ダイアログより上に重ねる。
   */
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host || items.length === 0 || typeof host.showPopover !== 'function') return
    if (host.matches(':popover-open')) host.hidePopover()
    host.showPopover()
  }, [items])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div ref={hostRef} popover="manual" className="toast-host" role="status" aria-live="polite" data-testid="toast-host">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone ?? 'info'}`}>
            <span className="toast__icon">{ICONS[item.tone ?? 'info']}</span>
            <div className="toast__body">
              <span className="toast__message">{item.message}</span>
              {item.detail != null && <span className="toast__detail">{item.detail}</span>}
            </div>
            <IconButton
              label={t('common.close')}
              size="sm"
              icon={<X size={14} strokeWidth={1.75} />}
              onClick={() => dismiss(item.id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
