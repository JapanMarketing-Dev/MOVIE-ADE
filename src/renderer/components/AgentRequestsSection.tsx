import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, Plus, RotateCcw, Send, Trash2 } from 'lucide-react'
import {
  builtinRequestText,
  resolveAgentRequests,
  toPrefs,
  type AgentRequest,
  type RequestLanguage
} from '@shared/agentRequests'
import { getLocale } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, IconButton, useToast } from '../ui'
import '../styles/settings.css'

/**
 * 全体のダッシュボードの「Agent への依頼」。人の確認リストの書き出し・コスト・dream・セキュリティ・SEO・Sentry などの依頼文を並べ、
 * 押すと開いているプロジェクトの Agent へその文を送るだけ（Agent の邪魔をせず、人が良い依頼をするための雛形）。
 * 選んだものはまとめて1つの依頼にできる。1回きりの依頼（登録など）は済んだら隠せる（「隠したものを表示」で戻せる）。
 * 全体から送ると、プロダクトごとの subagent で並行し、プロダクトの中でも並行するよう main が添える（@shared/agentRequests）
 */
export function AgentRequestsSection() {
  const t = useT()
  const toast = useToast()
  const lang: RequestLanguage = getLocale() === 'ja' ? 'ja' : 'en'
  const [requests, setRequests] = useState<AgentRequest[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
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
    update([...requests, { id, title: draft.title.trim(), text: draft.text, batch: false, custom: true, edited: false, hidden: false, once: false }])
    setDraft({ title: '', text: '' })
  }

  if (!requests) return <p className="st-note">{t('usage.loading')}</p>
  const hiddenCount = requests.filter((r) => r.hidden).length
  const shown = requests.filter((r) => showHidden || !r.hidden)
  const selected = requests.filter((r) => r.batch && !r.hidden).map((r) => r.id)

  return <div className="agent-requests" data-testid="agent-requests">
    <p className="st-note">{t('requests.intro')}</p>
    <ul className="agent-requests__list">
      {shown.map((r) => {
        const expanded = open === r.id
        return <li key={r.id} className={`agent-requests__item${r.hidden ? ' is-hidden' : ''}`} data-testid={`request-${r.id}`}>
          <div className="agent-requests__row">
            <input type="checkbox" checked={r.batch} disabled={r.hidden} aria-label={t('requests.select', { title: r.title })} onChange={(e) => patch(r.id, { batch: e.target.checked })} data-testid={`request-${r.id}-select`} />
            <button type="button" className="agent-requests__title" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)} data-testid={`request-${r.id}-toggle`}>
              {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              <span>{r.title}</span>
              {r.once && <span className="agent-requests__edited">{t('requests.once')}</span>}
              {r.edited && <span className="agent-requests__edited">{t('requests.edited')}</span>}
            </button>
            <IconButton size="sm" label={t(r.hidden ? 'requests.unhide' : 'requests.hide')} icon={r.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
              onClick={() => patch(r.id, { hidden: !r.hidden, batch: false })} data-testid={`request-${r.id}-hide`} />
            <Button icon={<Send size={12} />} disabled={sending || !r.text.trim()} onClick={() => send([r.id])} data-testid={`request-${r.id}-send`}>{t('requests.send')}</Button>
          </div>
          {expanded && <div className="agent-requests__detail">
            <textarea className="st-textarea agent-requests__text" rows={8} value={r.text} spellCheck={false} aria-label={r.title}
              onChange={(e) => patch(r.id, { text: e.target.value, edited: !r.custom && e.target.value !== builtinRequestText(r.id, lang) })} data-testid={`request-${r.id}-text`} />
            {(r.edited || r.custom) && <div className="agent-requests__actions">
              {r.edited && <Button variant="ghost" icon={<RotateCcw size={12} />} onClick={() => patch(r.id, { text: builtinRequestText(r.id, lang) ?? r.text, edited: false })} data-testid={`request-${r.id}-reset`}>{t('requests.reset')}</Button>}
              {r.custom && <IconButton size="sm" label={t('requests.remove')} icon={<Trash2 size={13} />} onClick={() => update(requests.filter((x) => x.id !== r.id))} data-testid={`request-${r.id}-remove`} />}
            </div>}
          </div>}
        </li>
      })}
    </ul>
    <div className="st-key__actions">
      {hiddenCount > 0 && <Button variant="ghost" icon={showHidden ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShowHidden(!showHidden)} data-testid="requests-show-hidden">
        {t(showHidden ? 'requests.hideHidden' : 'requests.showHidden', { count: hiddenCount })}
      </Button>}
      <Button variant="primary" icon={<Send size={13} />} disabled={sending || selected.length === 0} onClick={() => send(selected)} data-testid="requests-send-selected">{t('requests.sendSelected', { count: selected.length })}</Button>
    </div>
    <details className="agent-requests__add">
      <summary className="st-page__subheading">{t('requests.add')}</summary>
      <Field value={draft.title} placeholder={t('requests.addTitle')} aria-label={t('requests.addTitle')} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="request-add-title" />
      <textarea className="st-textarea" rows={4} value={draft.text} placeholder={t('requests.addText')} aria-label={t('requests.addText')} spellCheck={false} onChange={(e) => setDraft({ ...draft, text: e.target.value })} data-testid="request-add-text" />
      <div className="st-key__actions">
        <Button icon={<Plus size={13} />} disabled={!draft.title.trim() || !draft.text.trim()} onClick={add} data-testid="request-add">{t('requests.add')}</Button>
      </div>
    </details>
  </div>
}
