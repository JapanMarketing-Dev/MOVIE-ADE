import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { resolveAgentRequests, type AgentRequest, type RequestLanguage } from '@shared/agentRequests'
import { errorMessage } from '../lib/errors'
import { getLocale } from '@shared/i18n'
import { useT } from '../lib/i18n'
import { Button, useToast } from '../ui'

/**
 * 全体のダッシュボードから、用意した依頼（設定の「Agent への依頼」）をいつでも全体の Agent に送る。
 * 選んで送るだけ。文面の編集・定期の設定は設定の画面で行う
 */
export function OrchestraRequestPicker() {
  const t = useT()
  const toast = useToast()
  const lang: RequestLanguage = getLocale() === 'ja' ? 'ja' : 'en'
  const [requests, setRequests] = useState<AgentRequest[]>(() => resolveAgentRequests(undefined, lang))
  const [picked, setPicked] = useState('learn-human')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('app:settings').then((s) => { if (!cancelled) setRequests(resolveAgentRequests(s.agentRequests, lang)) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [lang])

  const send = () => {
    if (busy || !requests.some((r) => r.id === picked)) return
    setBusy(true)
    void window.ade.invoke('agentRequests:send', [picked])
      .then((result) => toast({ tone: result.ok ? 'success' : 'warning', message: result.ok ? t('orchestra.composerSent') : result.message }))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setBusy(false))
  }

  return <div className="orchestra-requests" data-testid="orchestra-requests">
    <select className="orchestra-requests__select" value={picked} aria-label={t('orchestra.requestPick')} onChange={(e) => setPicked(e.target.value)} data-testid="orchestra-request-select">
      {requests.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
    </select>
    <Button icon={<Send size={13} />} disabled={busy} onClick={send} data-testid="orchestra-request-send">{t('orchestra.requestSend')}</Button>
  </div>
}
