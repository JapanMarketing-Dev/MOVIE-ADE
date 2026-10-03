import { useEffect, useState } from 'react'
import type { AgentPreferences, Project } from '@shared/types'
import { AGENT_CATALOG } from '@shared/agentCatalog'
import { setProjectBypass } from '../lib/agentPrefs'
import { useT } from '../lib/i18n'

/**
 * 設定の Agents 節の「権限確認を省く（プロジェクトごと）」（security-3 [1]）。
 * 既定はどのプロジェクトも切。入れるときは、プロジェクトのパスと付く引数を見せて確認する。
 * 許したプロジェクトでだけ main がフォルダの信頼を書き、手で開いた Agent に権限確認を省く引数を付ける
 * （自動起動には付けない。決めるのは main の resolveAgentLaunchPolicy）。
 */
export function AgentBypassProjects({ value, onChange }: { value: AgentPreferences; onChange: (next: AgentPreferences) => void }) {
  const t = useT()
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    void window.ade.invoke('project:list').then((state) => setProjects(state.projects)).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    return window.ade.on('projects:changed', (state) => setProjects(state.projects))
  }, [])
  const flags = [AGENT_CATALOG.claude.yoloArgs, AGENT_CATALOG.codex.yoloArgs].join(' / ')
  const toggle = (project: Project, on: boolean) =>
    onChange(setProjectBypass(value, project.id, on, () => window.confirm(t('settings.agents.bypassConfirm', { project: project.name, path: project.folderPath, flags }))))

  return <div className="st-page__group" data-testid="agent-bypass-projects">
    <h3 className="st-page__subheading">{t('settings.agents.bypassTitle')}</h3>
    <p className="st-note st-note--warn">{t('settings.agents.bypassNote')}</p>
    {projects.length === 0 && <p className="st-note">{t('settings.agents.bypassNoProjects')}</p>}
    {projects.map((project) => {
      const on = value.bypassProjects.includes(project.id)
      // 名前とスイッチを1行に、パスはその下に折り返して出す（長いパスでスイッチが下へ落ちない）
      return <div key={project.id} className="st-agent-row" data-testid={`agent-bypass-${project.id}`}>
        <label className="st-agent-row__head">
          <span className="st-agent-row__name">{project.name}</span>
          <input type="checkbox" role="switch" className="st-switch" aria-label={t('settings.agents.bypassToggle', { project: project.name })}
            checked={on} onChange={(e) => toggle(project, e.target.checked)} />
        </label>
        <code className="st-bypass-path" title={project.folderPath}>{project.folderPath}</code>
      </div>
    })}
  </div>
}
