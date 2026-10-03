import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { ReactNode } from 'react'
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react'
import { IconButton } from './Button'
import { useT } from '../lib/i18n'
import { requestFeedback } from '../lib/feedbackEvents'
import { TOAST_GAP, getViewBoundsForToasts, subscribeViewBoundsForToasts, toastPlacement, type ToastPlacement } from '../lib/toastPlacement'

/**
 * トースト。処理の結果を、画面を止めずに知らせる。
 *
 * ⚠ 内蔵ブラウザ（WebContentsView）はDOMの上に重なるので、ビューの領域に出すと
 * 隠れる。ビューの位置を見て、ビューの外の DOM だけの領域へ置く（lib/toastPlacement.ts）。
 * どこにも入らないとき（フィードバックモードで右パネルを閉じたとき）は、
 * 登録された置き先（ツールバーの案内の枠。setToastNoticeFallback）へ回す。
 */

let noticeFallback: ((message: string) => void) | null = null

/** トーストを置ける場所が無いときに、本文を回す先（フィードバックモードのツールバーの案内の枠）。null で外す */
export function setToastNoticeFallback(fallback: ((message: string) => void) | null): void {
  noticeFallback = fallback
}

function currentPlacement(): ToastPlacement {
  return toastPlacement(getViewBoundsForToasts(), { width: window.innerWidth, height: window.innerHeight })
}

function placementStyle(placement: ToastPlacement): CSSProperties | undefined {
  if (placement.kind === 'side') {
    return placement.side === 'right'
      ? { right: placement.offset, left: 'auto', width: placement.width }
      : { left: placement.offset, right: 'auto', width: placement.width }
  }
  if (placement.kind === 'band') return { right: TOAST_GAP, left: 'auto', top: TOAST_GAP / 2, width: placement.width, maxHeight: placement.maxHeight }
  return undefined
}

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
      // ビューの外に置き場所が無ければ、ツールバーの案内の枠へ回す（ビューの裏に隠れたトーストを出さない）
      if (noticeFallback && currentPlacement().kind === 'notice') {
        noticeFallback(options.message)
        return
      }
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
  const view = useSyncExternalStore(subscribeViewBoundsForToasts, getViewBoundsForToasts)
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const placement = toastPlacement(view, viewport)
  useEffect(() => {
    const host = hostRef.current
    if (!host || items.length === 0 || typeof host.showPopover !== 'function') return
    if (host.matches(':popover-open')) host.hidePopover()
    host.showPopover()
  }, [items])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div ref={hostRef} popover="manual" className={`toast-host toast-host--${placement.kind}`} style={placementStyle(placement)} role="status" aria-live="polite" data-testid="toast-host">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone ?? 'info'}`}>
            <span className="toast__icon">{ICONS[item.tone ?? 'info']}</span>
            <div className="toast__body">
              <span className="toast__message">{item.message}</span>
              {item.detail != null && <span className="toast__detail">{item.detail}</span>}
              {/* エラーは、その場で報告できるようにする。題名にはエラーの要約（message）だけを入れ、detail（原因の全文・パスを含みうる）は入れない。
                  公開の Issue の題名なので、頭は言語に依らず「Error:」にそろえる */}
              {item.tone === 'danger' && <button type="button" className="toast__report" data-testid="toast-report"
                onClick={() => { dismiss(item.id); requestFeedback({ kind: 'bug', title: `Error: ${item.message.replace(/[\r\n]+/g, ' ').slice(0, 120)}` }) }}>
                {t('feedback.report')}
              </button>}
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
