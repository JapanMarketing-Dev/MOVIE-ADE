import { Circle, CircleCheck, ListChecks } from 'lucide-react'
import type { TranslationKey } from '@shared/i18n'
import type { OnboardingStepId } from '@shared/onboarding'
import { Button, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { formatShortcut } from '../lib/shortcut'
import { requestShowOnboarding } from './showOnboardingEvent'
import { notifySetupChanged, useSetupChecklist } from './useSetupChecklist'
import { agentLabel } from '@shared/agentCatalog'
import type { SetupItemId } from './setupChecklistState'
import '../styles/onboarding.css'

/** 済んでいない項目の「設定する」の行き先。設定の節・初回セットアップの手順・その場の操作。録る・送るは案内だけ */
type SetupAction = { kind: 'settings'; section: string } | { kind: 'onboarding'; step: OnboardingStepId } | { kind: 'addProject' } | { kind: 'installSkill' } | null

const ACTIONS: Record<SetupItemId, SetupAction> = {
  agent: { kind: 'settings', section: 'agents' },
  agentSkill: { kind: 'installSkill' },
  project: { kind: 'addProject' },
  transcription: { kind: 'settings', section: 'transcription' },
  decision: { kind: 'onboarding', step: 'decision' },
  permissions: { kind: 'onboarding', step: 'permissions' },
  firstRecording: null,
  firstSend: null
}

/**
 * セットアップのチェックリスト（設定の一番上の「Setup」の節）。済んだ項目は緑のチェックにし、取り消し線は付けない。
 * 済んだかは useSetupChecklist が実際の状態から決める（手でチェックしない）。
 */
export function SetupChecklist() {
  const t = useT()
  const toast = useToast()
  const { items, progress } = useSetupChecklist()
  if (!items || !progress) return null

  const run = (action: SetupAction) => {
    if (!action) return
    if (action.kind === 'settings') window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: action.section } }))
    else if (action.kind === 'onboarding') requestShowOnboarding(action.step)
    else if (action.kind === 'installSkill') void window.ade.invoke('agentSkill:install')
      .then((next) => {
        notifySetupChanged()
        if (next.some((s) => s.installed)) toast({ tone: 'success', message: t('agentSkill.installed', { agents: next.filter((s) => s.installed).map((s) => agentLabel(s.agent)).join(', ') }) })
        else toast({ tone: 'warning', message: t('agentSkill.notInstalled') })
      })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
    else void window.ade.invoke('project:add').catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  return <div className="setup-list" data-testid="setup-checklist">
    <p className={`ob-note${progress.complete ? ' ob-note--ok' : ''}`} role="status" data-testid="setup-progress">
      {progress.complete ? t('setup.allDone') : t('setup.progress', { done: progress.done, total: progress.total })}</p>
    <ul className="setup-list__items">
      {items.map(({ id, done }) => <li key={id} className="setup-item" data-done={done || undefined} data-testid={`setup-item-${id}`}>
        {done
          ? <CircleCheck size={16} className="setup-item__icon is-done" aria-hidden="true" />
          : <Circle size={16} className="setup-item__icon" aria-hidden="true" />}
        <div className="setup-item__text">
          <span className="setup-item__title">{t(`setup.item.${id}.title` as TranslationKey)}</span>
          {!done && <span className="ob-note">{t(`setup.item.${id}.hint` as TranslationKey, { record: formatShortcut('Mod', 'Shift', 'R') })}</span>}
        </div>
        <span className="visually-hidden">{t(done ? 'setup.done' : 'setup.notDone')}</span>
        {!done && ACTIONS[id] && <Button onClick={() => run(ACTIONS[id])} data-testid={`setup-item-${id}-action`}>
          {t(ACTIONS[id]!.kind === 'addProject' ? 'setup.action.addProject' : ACTIONS[id]!.kind === 'installSkill' ? 'agentSkill.install' : 'setup.action.setUp')}</Button>}
      </li>)}
    </ul>
  </div>
}

/**
 * サイドバーの下の小さな進み具合（「Setup 3/7」）。押すと設定の Setup の節を開く。全部済んだら消える。
 * Orca由来: ~/bench/orca/src/renderer/src/components/sidebar/SetupGuideSidebarEntry.tsx（MIT）
 */
export function SetupProgressLink() {
  const t = useT()
  const { progress } = useSetupChecklist()
  if (!progress || progress.complete) return null
  return <button type="button" className="setup-link" data-testid="setup-progress-link"
    onClick={() => window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: 'setup' } }))}>
    <ListChecks size={14} aria-hidden="true" />
    <span>{t('setup.sidebar', { done: progress.done, total: progress.total })}</span>
    <span className="setup-link__bar" aria-hidden="true"><span style={{ transform: `scaleX(${progress.done / Math.max(1, progress.total)})` }} /></span>
  </button>
}
