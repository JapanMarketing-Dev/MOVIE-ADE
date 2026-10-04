import { Suspense, lazy, useEffect, useState } from 'react'
import { Copy, FileJson, FolderOpen } from 'lucide-react'
import type { SettingsFileInfo } from '@shared/types'
import { Button, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { AgentSkillCard } from './AgentSkillCard'

const SettingsJsonEditor = lazy(() => import('./SettingsJsonEditor'))

/**
 * 設定のページの先頭に出す settings.json の欄。
 * 場所・開く（内蔵の Monaco）・フォルダで表示・エージェントに渡すプロンプト、壊れているときの理由、平文のキーの警告。
 * 状態は main（src/main/settings.ts）が持ち、外部の変更・壊れた・直ったのたびに読み直す。
 */
export function SettingsFileCard() {
  const t = useT()
  const toast = useToast()
  const [info, setInfo] = useState<SettingsFileInfo | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const refresh = () => void window.ade.invoke('settingsFile:info').then(setInfo).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    refresh()
    const offChanged = window.ade.on('settings:changed', refresh)
    const offError = window.ade.on('settingsFile:error', refresh)
    return () => { offChanged(); offError() }
  }, [])

  if (!info) return null
  const prompt = t('settings.file.agentPrompt', { path: info.path, schema: info.schemaPath })
  const copyPrompt = () => void navigator.clipboard.writeText(prompt)
    .then(() => toast({ tone: 'success', message: t('settings.file.copied') }))
    .catch(() => undefined) // クリップボードが使えない（想定内。プロンプトは画面にも出ている）

  return <section className="st-file" data-testid="settings-file" aria-label={t('settings.file.title')}>
    <div className="st-file__head">
      <FileJson size={14} strokeWidth={1.5} aria-hidden="true" />
      <code className="st-file__path" title={info.path} data-testid="settings-file-path">{info.path}</code>
    </div>
    <p className="st-note">{t('settings.file.note')}</p>
    {info.error && <div className="st-file__error" role="alert" data-testid="settings-file-error">
      <p className="st-note st-note--warn">{t('settings.file.error')}</p>
      <p className="st-note st-note--warn"><code>{info.error.line ? t('settings.file.errorAt', { line: String(info.error.line), message: info.error.message }) : info.error.message}</code></p>
    </div>}
    {info.plaintextKeys.length > 0 && <p className="st-note st-note--warn" data-testid="settings-file-plaintext">{t('settings.file.plaintextWarning', { paths: info.plaintextKeys.join(', ') })}</p>}
    <div className="st-file__actions">
      <Button icon={<FileJson size={14} strokeWidth={1.5} />} onClick={() => setOpen((v) => !v)} data-testid="settings-file-open">{t(open ? 'settings.file.close' : 'settings.file.open')}</Button>
      <Button variant="ghost" icon={<FolderOpen size={14} strokeWidth={1.5} />} onClick={() => void window.ade.invoke('settingsFile:reveal')} data-testid="settings-file-reveal">{t('settings.file.reveal')}</Button>
    </div>
    <AgentSkillCard />
    <details className="st-key">
      <summary><span>{t('settings.file.agentTitle')}</span></summary>
      <div className="st-key__body">
        <pre className="st-file__prompt" data-testid="settings-file-prompt">{prompt}</pre>
        <div className="st-key__actions">
          <Button variant="ghost" icon={<Copy size={14} strokeWidth={1.5} />} onClick={copyPrompt}>{t('settings.file.copyPrompt')}</Button>
        </div>
      </div>
    </details>
    {open && <Suspense fallback={<Spinner />}><SettingsJsonEditor path={info.path} /></Suspense>}
  </section>
}
