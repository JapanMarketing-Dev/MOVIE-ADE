import { useEffect, useState } from 'react'

/**
 * 開いているモーダル（ui/Modal）の数。
 *
 * 内蔵ブラウザ（WebContentsView）は DOM の上の別のレイヤーに描かれるので、モーダルを開いても上に重なって隠してしまう
 * （フィードバックの画面・画面の確認・GitHub / GitLab に送る など）。App はこれが 1 以上の間、ビューを 0 サイズにして隠す。
 */

let count = 0
const listeners = new Set<(open: boolean) => void>()

function emit(): void {
  for (const listener of listeners) listener(count > 0)
}

/** Modal が開いたときに呼ぶ。戻り値を閉じたときに呼ぶ */
export function registerOpenModal(): () => void {
  count++
  emit()
  let done = false
  return () => {
    if (done) return
    done = true
    count = Math.max(0, count - 1)
    emit()
  }
}

/** モーダルが1つでも開いているか */
export function useAnyModalOpen(): boolean {
  const [open, setOpen] = useState(count > 0)
  useEffect(() => {
    listeners.add(setOpen)
    setOpen(count > 0)
    return () => { listeners.delete(setOpen) }
  }, [])
  return open
}
