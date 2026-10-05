import { useState } from 'react'
import { FolderPlus, Download } from 'lucide-react'
import type { InstalledBrowserExtension } from '@shared/browserExtensions'
import { Button, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { useBrowserExtensions } from './BrowserExtensionsButton'

/**
 * 設定のページの「ブラウザ拡張機能」。内蔵ブラウザにだけ読み込む Chrome 拡張の追加・取り込み・有効の切り替え・削除。
 * フォルダの選択（ダイアログ）と取り込みの元は main が決める。画面からはパスを作って送らない（一覧に出ている行の path を返すだけ）
 */
export function BrowserExtensionsSection({ recording }: { recording: boolean }) {
  const t = useT()
  const toast = useToast()
  const list = useBrowserExtensions()
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState<InstalledBrowserExtension[] | null>(null)

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  const locked = recording || busy

  return <div id="settings-extensions" className="st-page__group" data-testid="browser-extensions-settings">
    <p className="st-note">{t('browserExtensions.intro')}</p>
    <p className="st-note st-note--warn">{t('browserExtensions.warning')}</p>
    {list.length === 0 && <p className="st-note">{t('browserExtensions.empty')}</p>}
    {list.map((ext) => <div key={ext.path} className="st-agent-row" data-testid="browser-extension-row" data-disabled={!ext.enabled || undefined}>
      <div className="st-agent-row__head">
        <span className="st-agent-row__name">{ext.name}{ext.version ? ` ${ext.version}` : ''}</span>
        {ext.imported && <span className="st-agent-row__state">{t('browserExtensions.imported')}</span>}
        <input type="checkbox" role="switch" className="st-switch" aria-label={t('browserExtensions.enabled', { name: ext.name })} checked={ext.enabled} disabled={locked}
          onChange={(e) => { const on = e.target.checked; void run(() => window.ade.invoke('browserExtensions:setEnabled', ext.path, on)) }} />
      </div>
      <p className="st-note"><code title={ext.path}>{ext.path}</code></p>
      {ext.error && <p className="st-note st-note--warn" data-testid="browser-extension-error">{t('browserExtensions.loadFailed', { error: ext.error })}</p>}
      <div className="st-agent__reset">
        <Button variant="ghost" disabled={locked} onClick={() => void run(() => window.ade.invoke('browserExtensions:remove', ext.path))}>{t('browserExtensions.remove')}</Button>
      </div>
    </div>)}
    <div className="st-row">
      <Button icon={<FolderPlus size={14} strokeWidth={1.5} />} disabled={locked} data-testid="browser-extension-add"
        onClick={() => void run(() => window.ade.invoke('browserExtensions:addFolder'))}>{t('browserExtensions.addFolder')}</Button>
      <Button icon={<Download size={14} strokeWidth={1.5} />} disabled={locked} data-testid="browser-extension-scan"
        onClick={() => void run(async () => setInstalled(await window.ade.invoke('browserExtensions:scanInstalled')))}>{t('browserExtensions.importChrome')}</Button>
    </div>
    {installed && <div data-testid="browser-extension-installed">
      <h3 className="st-page__subheading">{t('browserExtensions.importTitle')}</h3>
      {installed.length === 0 && <p className="st-note">{t('browserExtensions.importNone')}</p>}
      {installed.map((ext) => <div key={ext.key} className="st-row">
        <span className="st-row__label">{ext.name} {ext.version}<span className="st-note"> — {ext.browser} / {ext.profile}</span></span>
        <Button variant="ghost" disabled={locked} onClick={() => void run(async () => {
          await window.ade.invoke('browserExtensions:import', ext.key)
          setInstalled((prev) => prev?.map((p) => p.id === ext.id ? { ...p, imported: true } : p) ?? null)
        })}>{ext.imported ? t('browserExtensions.reimport') : t('browserExtensions.import')}</Button>
      </div>)}
    </div>}
    <p className="st-note">{t('browserExtensions.recordingNote')}</p>
    <p className="st-note">{t('browserExtensions.limits')}</p>
  </div>
}
