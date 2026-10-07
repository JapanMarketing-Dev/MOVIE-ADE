import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, RotateCcw, Send, Trash2 } from 'lucide-react'
import {
  AGENT_REQUEST_SCHEDULES,
  builtinRequestText,
  resolveAgentRequests,
  toPrefs,
  type AgentRequest,
  type AgentRequestSchedule,
  type RequestLanguage
} from '@shared/agentRequests'
import { getLocale, type TranslationKey } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, IconButton, Segmented, useToast } from '../ui'

/**
 * 設定の「Agent への依頼」。dream・コンパクト・セキュリティ・SEO・分析・Sentry などの依頼文を並べ、
 * 押すと開いているプロジェクトの Agent へその文を送るだけ（Agent の邪魔をせず、人が良い依頼をするための雛形）。
 * 選んだものはまとめて1つの依頼にでき、毎日・毎週の定期にもできる（main が Agent の手すきのときに送る）。
 * オーケストレーターから送ると、すべてのプロダクトに subagent で並行して行うよう main が添える（@shared/agentRequests）
 */
export function AgentRequestsSection() {
  const t = useT()
  const toast = useToast()
  const lang: RequestLanguage = getLocale() === 'ja' ? 'ja' : 'en'
  const [requests, setRequests] = useState<AgentRequest[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState({ title: '', text: '' })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('app:settings').then((s) => { if (!cancelled) setRequests(resolveAgentRequests(s.agentRequests, lang)) }).catch(() => { if (!cancelled) setRequests(resolveAgentRequests(undefined, lang)) })
    return () => { cancelled = true }
  }, [lang])

  /** 変えたらすぐ一覧に出し、保存は少し待ってまとめる（文面の入力のたびに書かない） */
  const update = useCallback((next: AgentRequest[]) => {
    setRequests(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void window.ade.invoke('settings:agentRequests', toPrefs(next, lang)).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
    }, 400)
  }, [lang, toast])
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const patch = (id: string, change: Partial<AgentRequest>) => requests && update(requests.map((r) => (r.id === id ? { ...r, ...change } : r)))

  const send = (ids: string[]) => {
    if (!ids.length || sending) return
    setSending(true)
    // 送る前に今の変更を保存しておく（main は保存した文面を送る）
    const flush = requests ? window.ade.invoke('settings:agentRequests', toPrefs(requests, lang)) : Promise.resolve()
    void flush.then(() => window.ade.invoke('agentRequests:send', ids))
      .then((result) => toast(result.ok ? { tone: 'success', message: t('requests.sent', { count: ids.length }) } : { tone: 'warning', message: result.message }))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setSending(false))
  }

  const add = () => {
    if (!requests || !draft.title.trim() || !draft.text.trim()) return
    const id = `custom-${Date.now().toString(36)}`
    update([...requests, { id, title: draft.title.trim(), text: draft.text, schedule: 'off', batch: false, custom: true, edited: false }])
    setDraft({ title: '', text: '' })
  }

  if (!requests) return <p className="st-note">{t('usage.loading')}</p>
  const selected = requests.filter((r) => r.batch).map((r) => r.id)
  const scheduleOptions = AGENT_REQUEST_SCHEDULES.map((value) => ({ value, label: t(`requests.schedule.${value}` as TranslationKey), testId: `request-schedule-${value}` }))

  return <div className="agent-requests" data-testid="agent-requests">
    <p className="st-note">{t('requests.intro')}</p>
    <ul className="agent-requests__list">
      {requests.map((r) => {
        const expanded = open === r.id
        return <li key={r.id} className="agent-requests__item" data-testid={`request-${r.id}`}>
          <div className="agent-requests__row">
            <input type="checkbox" checked={r.batch} aria-label={t('requests.select', { title: r.title })} onChange={(e) => patch(r.id, { batch: e.target.checked })} data-testid={`request-${r.id}-select`} />
            <button type="button" className="agent-requests__title" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)} data-testid={`request-${r.id}-toggle`}>
              {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              <span>{r.title}</span>
              {r.edited && <span className="agent-requests__edited">{t('requests.edited')}</span>}
              {r.schedule !== 'off' && <span className="agent-requests__edited">{t(`requests.schedule.${r.schedule}` as TranslationKey)}</span>}
            </button>
            <Button icon={<Send size={12} />} disabled={sending || !r.text.trim()} onClick={() => send([r.id])} data-testid={`request-${r.id}-send`}>{t('requests.send')}</Button>
          </div>
          {expanded && <div className="agent-requests__detail">
            <textarea className="st-textarea agent-requests__text" rows={8} value={r.text} spellCheck={false} aria-label={r.title}
              onChange={(e) => patch(r.id, { text: e.target.value, edited: !r.custom && e.target.value !== builtinRequestText(r.id, lang) })} data-testid={`request-${r.id}-text`} />
            <div className="agent-requests__actions">
              <span className="st-note">{t('requests.schedule.label')}</span>
              <Segmented<AgentRequestSchedule> ariaLabel={t('requests.schedule.label')} value={r.schedule} onChange={(schedule) => patch(r.id, { schedule })} options={scheduleOptions} />
              {r.edited && <Button variant="ghost" icon={<RotateCcw size={12} />} onClick={() => patch(r.id, { text: builtinRequestText(r.id, lang) ?? r.text, edited: false })} data-testid={`request-${r.id}-reset`}>{t('requests.reset')}</Button>}
              {r.custom && <IconButton size="sm" label={t('requests.remove')} icon={<Trash2 size={13} />} onClick={() => update(requests.filter((x) => x.id !== r.id))} data-testid={`request-${r.id}-remove`} />}
            </div>
          </div>}
        </li>
      })}
    </ul>
    <div className="st-key__actions">
      <Button variant="primary" icon={<Send size={13} />} disabled={sending || selected.length === 0} onClick={() => send(selected)} data-testid="requests-send-selected">{t('requests.sendSelected', { count: selected.length })}</Button>
    </div>
    <p className="st-note">{t('requests.scheduleHint')}</p>
    <div className="agent-requests__add">
      <h3 className="st-page__subheading">{t('requests.add')}</h3>
      <Field value={draft.title} placeholder={t('requests.addTitle')} aria-label={t('requests.addTitle')} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="request-add-title" />
      <textarea className="st-textarea" rows={4} value={draft.text} placeholder={t('requests.addText')} aria-label={t('requests.addText')} spellCheck={false} onChange={(e) => setDraft({ ...draft, text: e.target.value })} data-testid="request-add-text" />
      <div className="st-key__actions">
        <Button icon={<Plus size={13} />} disabled={!draft.title.trim() || !draft.text.trim()} onClick={add} data-testid="request-add">{t('requests.add')}</Button>
      </div>
    </div>
  </div>
}
