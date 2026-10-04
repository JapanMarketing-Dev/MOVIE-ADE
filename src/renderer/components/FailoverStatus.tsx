import { useEffect, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import type { FailoverNotice } from '@shared/failover'
import { useToast } from '../ui'
import { useT } from '../lib/i18n'
import '../styles/failover.css'

/**
 * 上限での自動切り替えの知らせ（main の failover:notice）。トーストで知らせ、
 * 切り替えた先の Agent をフッターにしばらく出す（詳しい文はマウスを乗せると出る）。
 */

/** フッターに出しておく間 */
const CHIP_MS = 30 * 60 * 1000

export function FailoverStatus() {
  const t = useT()
  const toast = useToast()
  const [notice, setNotice] = useState<FailoverNotice | null>(null)

  useEffect(() => window.ade.on('failover:notice', (next) => {
    toast({ tone: 'info', message: next.message, duration: 12_000 })
    if (next.toLabel) setNotice(next)
  }), [toast])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), Math.max(0, notice.at + CHIP_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice?.toLabel) return null
  return (
    <span className="failover-chip" title={notice.message} data-testid="failover-status">
      <ArrowLeftRight size={12} aria-hidden="true" />
      {t('failover.footer', { agent: notice.toLabel })}
    </span>
  )
}
