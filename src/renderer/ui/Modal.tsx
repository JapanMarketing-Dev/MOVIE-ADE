import { useEffect, useRef, type ReactNode } from 'react'

/** ネイティブdialogで背景へのTab移動を止め、閉じたら元の操作へ戻す。 */
export function Modal({ label, className, onClose, children }: { label: string; className: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  return <dialog ref={ref} className={className} aria-label={label} onCancel={(event) => { event.preventDefault(); onClose() }}>{children}</dialog>
}
