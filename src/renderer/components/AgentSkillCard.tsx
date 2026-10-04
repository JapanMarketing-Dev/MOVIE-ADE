import { useCallback, useEffect, useState } from 'react'
import { CircleCheck, Download, RefreshCw } from 'lucide-react'
import type { AgentSkillStatus } from '@shared/agentSkill'
import { agentLabel } from '@shared/agentCatalog'
import { Button, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { notifySetupChanged } from '../onboarding/useSetupChecklist'
import '../styles/settings.css'

/**
 * Ferret の設定を変える skill（Claude Code・Codex）の状態と［入れる］ボタン。
 * 入れると、Agent に「Ferret でこうしたい」と頼むだけで、Agent が settings.json を全体／プロジェクトの範囲で書き換える。
 * 初回セットアップの Agent の手順と、設定の settings.json の欄で使う。
 */
export function AgentSkillCard() {
  const t = useT()
  const toast = useToast()
  const [status, setStatus] = useState<AgentSkillStatus[] | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => void window.ade.invoke('agentSkill:status').then(setStatus).catch(() => setStatus([])), [])
  useEffect(() => refresh(), [refresh])

  if (!status) return null
  const installed = status.filter((s) => s.installed)
  const stale = installed.some((s) => !s.upToDate)
  // 使っている Agent（設定のフォルダがある）のうち、まだ入れていないもの
  const missing = status.filter((s) => s.agentDirExists && !s.installed && !s.foreign)
  const install = () => {
    setBusy(true)
    void window.ade.invoke('agentSkill:install')
      .then((next) => {
        setStatus(next)
        notifySetupChanged()
        toast({ tone: 'success', message: t('agentSkill.installed', { agents: next.filter((s) => s.installed).map((s) => agentLabel(s.agent)).join(', ') }) })
      })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setBusy(false))
  }

  return <div className="agent-skill" data-testid="agent-skill">
    <div className="agent-skill__text">
      <span className="agent-skill__title">{t('agentSkill.title')}</span>
      <span className="st-note">{t('agentSkill.description')}</span>
      {installed.length > 0 && <span className="st-note agent-skill__state" data-testid="agent-skill-state">
        <CircleCheck size={12} aria-hidden="true" />{t('agentSkill.installedIn', { agents: installed.map((s) => agentLabel(s.agent)).join(', ') })}</span>}
      {status.filter((s) => s.foreign).map((s) => <span key={s.agent} className="st-note st-note--warn">{t('agentSkill.foreign', { path: s.path })}</span>)}
    </div>
    {(installed.length === 0 || missing.length > 0 || stale) && <Button variant={installed.length === 0 ? 'primary' : 'default'} busy={busy}
      icon={installed.length === 0 ? <Download size={14} strokeWidth={1.75} /> : <RefreshCw size={14} strokeWidth={1.75} />}
      onClick={install} data-testid="agent-skill-install">
      {t(installed.length === 0 ? 'agentSkill.install' : 'agentSkill.update')}</Button>}
  </div>
}
