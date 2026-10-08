import { useEffect, useId, useState } from 'react'
import type { Project } from '@shared/types'
import { MAX_BROWSER_PROFILE_LENGTH, browserProfiles, sanitizeBrowserProfile } from '@shared/browserProfile'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Field, useToast } from '../ui'

/**
 * 設定の「ブラウザのログイン」。内蔵ブラウザのログイン（Cookie・サイトのデータ）は既定ですべてのプロジェクトで共有する。
 * クライアントが違うなど分けたいプロジェクトにだけ組の名前を付ける（同じ名前のプロジェクト同士で共有。@shared/browserProfile）。
 * 保存は main の project:update（開いているプロジェクトなら、タブを新しい組で開き直す）
 */
export function BrowserProfilesSection() {
  const t = useT()
  const toast = useToast()
  const listId = useId()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    const load = () => void window.ade.invoke('project:list').then((list) => { if (!cancelled) setProjects(list.projects) }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    load()
    const off = window.ade.on('projects:changed', (state) => setProjects(state.projects))
    return () => { cancelled = true; off() }
  }, [])

  if (!projects) return <p className="st-note">{t('usage.loading')}</p>
  const groups = browserProfiles(projects)
  const save = (project: Project, value: string) => {
    const next = sanitizeBrowserProfile(value) ?? ''
    setDrafts(({ [project.id]: _, ...rest }) => rest)
    if (next === (project.browserProfile ?? '')) return
    void window.ade.invoke('project:update', { id: project.id, browserProfile: next })
      .then((state) => setProjects(state.projects))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }
  return <div className="st-page__group" data-testid="browser-profiles-settings">
    <p className="st-note">{t('browserProfiles.intro')}</p>
    <p className="st-note">{t('browserProfiles.howTo')}</p>
    <datalist id={listId}>{groups.map((g) => <option key={g} value={g} />)}</datalist>
    {projects.map((p) => (
      <div key={p.id} className="st-row">
        <span className="st-row__label" title={p.folderPath}>{p.name}</span>
        <Field className="browser-profiles__field" type="text" list={listId} maxLength={MAX_BROWSER_PROFILE_LENGTH} spellCheck={false}
          aria-label={t('browserProfiles.fieldLabel', { name: p.name })} placeholder={t('browserProfiles.shared')}
          value={drafts[p.id] ?? p.browserProfile ?? ''}
          onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
          onBlur={(e) => save(p, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          data-testid={`browser-profile-${p.id}`} />
      </div>
    ))}
  </div>
}
