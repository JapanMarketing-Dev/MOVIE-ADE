import type { BaseWindow, WebContentsView } from 'electron'
import { reportHandled } from '@shared/report'

/**
 * WebContentsView を安全に片付ける（FERRET-1Q：Windows の main の access-violation の再発防止）。
 * 先に隠してウインドウから外し、webContents の close は次のティックに回す。
 * 同じ流れの中で removeChildView と close が重なる・そのビュー自身のイベントの中で閉じると、Electron のネイティブ側で落ちることがある
 */
export function retireView(window: BaseWindow | null | undefined, view: WebContentsView, op: string): void {
  const wc = view.webContents
  try {
    if (!wc.isDestroyed()) {
      view.setVisible(false)
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view)
  } catch (err) {
    reportHandled(err, { area: 'browser', op })
  }
  setImmediate(() => {
    try {
      if (!wc.isDestroyed()) wc.close()
    } catch (err) {
      reportHandled(err, { area: 'browser', op })
    }
  })
}
