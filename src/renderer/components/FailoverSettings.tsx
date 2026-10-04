import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Info, Plus, X } from 'lucide-react'
import { agentLabel } from '@shared/agentCatalog'
import { DEFAULT_LIMIT_FAILOVER, MAX_FAILOVER_THRESHOLD, MIN_FAILOVER_THRESHOLD, type LimitFailoverPrefs } from '@shared/failover'
import type { AgentOption, TuiAgent } from '@shared/types'
import { IconButton } from '../ui'
import { AgentIcon } from './AgentIcon'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import '../styles/failover.css'

/**
 * 設定のアカウントの節の「上限での自動切り替え」。保存は main 側ですぐ行う（failover:set）。
 * - オン／オフ、上限とみなす使用量、先に同じ Agent の別のアカウントへ切り替えるか
 * - 引き継ぐ Agent の順番（上下の並べ替え・外す・追加）
 * - 優先順位の高い Agent の枠が戻ったら戻すか
 */

const THRESHOLD_STEPS = [80, 85, 90, 95, 98, 100].filter((n) => n >= MIN_FAILOVER_THRESHOLD && n <= MAX_FAILOVER_THRESHOLD)

export function FailoverSettings() {
  const t = useT()
  const [prefs, setPrefs] = useState<LimitFailoverPrefs>(DEFAULT_LIMIT_FAILOVER)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    void window.ade.invoke('failover:get').then((p) => { if (!stopped) setPrefs(p) }).catch((err: unknown) => setError(errorMessage(err)))
    void window.ade.invoke('agents:list').then((list) => { if (!stopped) setAgents(list) }).catch(() => undefined) // 一覧が取れなくても順番は直せる（想定内）
    const off = window.ade.on('agents:changed', setAgents)
    return () => { stopped = true; off() }
  }, [])

  const save = (next: LimitFailoverPrefs) => {
    setPrefs(next)
    setError(null)
    void window.ade.invoke('failover:set', next).then(setPrefs).catch((err: unknown) => setError(errorMessage(err)))
  }

  const order = prefs.agentOrder
  const move = (index: number, delta: number) => {
    const next = [...order]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item!)
    save({ ...prefs, agentOrder: next })
  }
  const remove = (agent: TuiAgent) => save({ ...prefs, agentOrder: order.filter((a) => a !== agent) })
  const addable = agents.filter((a) => a.enabled && a.installed && !order.includes(a.id))
  const installed = (agent: TuiAgent) => agents.length === 0 || agents.some((a) => a.id === agent && a.installed)
  const name = (agent: TuiAgent) => agents.find((a) => a.id === agent)?.label ?? agentLabel(agent)
  const thresholds = THRESHOLD_STEPS.includes(prefs.thresholdPercent) ? THRESHOLD_STEPS : [...THRESHOLD_STEPS, prefs.thresholdPercent].sort((a, b) => a - b)

  return (
    <div className="failover" id="settings-failover" data-testid="settings-failover">
      <h4 className="st-page__subheading">{t('failover.title')}</h4>
      <p className="st-note">
        <Info size={12} aria-hidden="true" />
        {t('failover.intro')}
      </p>
      {error && <p className="st-note st-note--warn" role="alert">{error}</p>}
      <label className="st-row st-row--switch">
        <span className="st-row__label">{t('failover.enabled')}</span>
        <input type="checkbox" role="switch" className="st-switch" checked={prefs.enabled} onChange={(e) => save({ ...prefs, enabled: e.target.checked })} data-testid="failover-enabled" />
      </label>
      <fieldset className="failover__body" disabled={!prefs.enabled}>
        <label className="st-row">
          <span className="st-row__label">{t('failover.threshold')}</span>
          <span className="rv-select">
            <select value={prefs.thresholdPercent} onChange={(e) => save({ ...prefs, thresholdPercent: Number(e.target.value) })} data-testid="failover-threshold">
              {thresholds.map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>
          </span>
        </label>
        <p className="st-note">{t('failover.thresholdHint')}</p>
        <label className="st-row st-row--switch">
          <span className="st-row__label">{t('failover.switchAccounts')}</span>
          <input type="checkbox" role="switch" className="st-switch" checked={prefs.switchAccounts} onChange={(e) => save({ ...prefs, switchAccounts: e.target.checked })} data-testid="failover-switch-accounts" />
        </label>

        <div className="failover__order-head">{t('failover.order')}</div>
        <ol className="failover__order" data-testid="failover-order">
          {order.map((agent, i) => (
            <li key={agent} className="failover__item" data-agent={agent}>
              <span className="failover__rank" aria-hidden="true">{i + 1}</span>
              <AgentIcon agent={agent} label={name(agent)} size={13} />
              <span className="failover__name">{name(agent)}</span>
              {!installed(agent) && <span className="failover__muted">{t('failover.notInstalled')}</span>}
              <span className="failover__actions">
                <IconButton label={t('failover.moveUp', { agent: name(agent) })} icon={<ArrowUp size={13} />} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton label={t('failover.moveDown', { agent: name(agent) })} icon={<ArrowDown size={13} />} disabled={i === order.length - 1} onClick={() => move(i, 1)} />
                <IconButton label={t('failover.removeFromOrder', { agent: name(agent) })} icon={<X size={13} />} onClick={() => remove(agent)} />
              </span>
            </li>
          ))}
        </ol>
        {addable.length > 0 && (
          <label className="failover__add">
            <Plus size={13} aria-hidden="true" />
            <span className="rv-select">
              <select value="" aria-label={t('failover.addToOrder')} onChange={(e) => { if (e.target.value) save({ ...prefs, agentOrder: [...order, e.target.value as TuiAgent] }) }} data-testid="failover-add">
                <option value="">{t('failover.addToOrder')}</option>
                {addable.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </span>
          </label>
        )}
        <p className="st-note">{t('failover.orderHint')}</p>

        <label className="st-row st-row--switch">
          <span className="st-row__label">{t('failover.returnToPreferred')}</span>
          <input type="checkbox" role="switch" className="st-switch" checked={prefs.returnToPreferred} onChange={(e) => save({ ...prefs, returnToPreferred: e.target.checked })} data-testid="failover-return" />
        </label>
        <p className="st-note">{t('failover.returnHint')}</p>
        <p className="st-note">{t('failover.howItContinues')}</p>
      </fieldset>
    </div>
  )
}
