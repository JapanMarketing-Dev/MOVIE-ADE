import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 初回起動の「クラッシュレポートを送ります」の案内（1回だけ）。
 * 実際に送る起動（配布版で設定が ON）のときだけ出す。dev 起動・E2E では出ない。
 * 内蔵ブラウザの上にも出るよう、トーストと同じ置き場所（popover・右上）を使う。
 */
export function CrashReportNotice() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.ade.invoke('telemetry:state').then((s) => setOpen(s.active && s.enabled && !s.noticeShown)).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!open || !host || typeof host.showPopover !== 'function') return
    if (!host.matches(':popover-open')) host.showPopover()
  }, [open])

  if (!open) return null
  const close = (turnOff: boolean) => {
    setOpen(false)
    // OFF にしたときも案内は出し終えた扱い（settings:crashReports が一緒に記録する）
    const done = turnOff ? window.ade.invoke('settings:crashReports', false) : window.ade.invoke('telemetry:noticeShown')
    void done.catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  }
  return (
    <div ref={hostRef} popover="manual" className="toast-host" role="status" aria-live="polite" data-testid="crash-report-notice">
      <div className="toast toast--info">
        <span className="toast__icon"><ShieldCheck size={16} strokeWidth={1.75} /></span>
        <div className="toast__body">
          <span className="toast__message">{t('crashNotice.message')}</span>
          <span className="toast__detail">{t('crashNotice.detail')}</span>
          <span style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-3)', pointerEvents: 'auto' }}>
            <Button variant="ghost" onClick={() => close(true)}>{t('crashNotice.turnOff')}</Button>
            <Button onClick={() => close(false)}>{t('crashNotice.ok')}</Button>
          </span>
        </div>
      </div>
    </div>
  )
}
