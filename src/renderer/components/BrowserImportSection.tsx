import { useEffect, useState } from 'react'
import { FileUp, History, Search, Trash2 } from 'lucide-react'
import type { BrowserImportStatus, HistorySourceInfo } from '@shared/browserImport'
import { Button, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'

/**
 * 設定のページの「ブラウザから取り込む」。ほかのブラウザで書き出したパスワードの CSV と、Chrome・Edge・Brave・Arc・Safari の履歴を取り込む。
 * CSV の選択（ダイアログ）・履歴の元は main が決める。画面からはパスを送らない（一覧に出ている元の key を返すだけ）。
 * 画面に出すのは件数だけ（パスワード・ユーザー名の一覧は出さない）
 */
export function BrowserImportSection() {
  const t = useT()
  const toast = useToast()
  const [status, setStatus] = useState<BrowserImportStatus | null>(null)
  const [sources, setSources] = useState<HistorySourceInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  /** この画面で CSV を取り込んだ（元の CSV を消す案内を出し続ける） */
  const [csvImported, setCsvImported] = useState(false)

  useEffect(() => {
    void window.ade.invoke('browserImport:status').then(setStatus).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  }, [])

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

  const importPasswords = () => void run(async () => {
    const result = await window.ade.invoke('browserImport:importPasswords')
    if (!result) return
    setStatus(await window.ade.invoke('browserImport:status'))
    toast({ tone: 'success', message: t('browserImport.passwords.imported', { added: result.added, updated: result.updated, skipped: result.skipped }) })
    // 書き出した CSV は平文。取り込んだら消してもらう（トーストは消えるので、節の中に出し続ける）
    setCsvImported(true)
  })

  return <div id="settings-browser-import" className="st-page__group" data-testid="browser-import-settings">
    <p className="st-note">{t('browserImport.intro')}</p>

    <h3 className="st-page__subheading">{t('browserImport.passwords.title')}</h3>
    <p className="st-note">{t('browserImport.passwords.howTo')}</p>
    <div className="st-row">
      <span className="st-row__label" data-testid="browser-import-password-count">{t('browserImport.passwords.count', { count: status?.passwords.count ?? 0 })}</span>
    </div>
    {csvImported && <p className="st-note st-note--warn" data-testid="browser-import-delete-csv">{t('browserImport.passwords.deleteCsv')}</p>}
    {status && !status.passwords.persisted && <p className="st-note st-note--warn">{t('browserImport.passwords.notPersisted')}</p>}
    <div className="st-row st-row--buttons">
      <Button icon={<FileUp size={14} strokeWidth={1.5} />} disabled={busy} data-testid="browser-import-passwords" onClick={importPasswords}>{t('browserImport.passwords.import')}</Button>
      <Button variant="ghost" icon={<Trash2 size={14} strokeWidth={1.5} />} disabled={busy || !status?.passwords.count} data-testid="browser-import-passwords-clear"
        onClick={() => void run(async () => {
          setStatus(await window.ade.invoke('browserImport:clearPasswords'))
          toast({ tone: 'success', message: t('browserImport.passwords.cleared') })
        })}>{t('browserImport.passwords.clear')}</Button>
    </div>

    <h3 className="st-page__subheading">{t('browserImport.history.title')}</h3>
    <p className="st-note">{t('browserImport.history.note')}</p>
    <div className="st-row">
      <span className="st-row__label" data-testid="browser-import-history-count">{t('browserImport.history.count', { count: status?.history.count ?? 0 })}</span>
    </div>
    <div className="st-row st-row--buttons">
      <Button icon={<Search size={14} strokeWidth={1.5} />} disabled={busy} data-testid="browser-import-history-detect"
        onClick={() => void run(async () => setSources(await window.ade.invoke('browserImport:historySources')))}>{t('browserImport.history.detect')}</Button>
      <Button variant="ghost" icon={<Trash2 size={14} strokeWidth={1.5} />} disabled={busy || !status?.history.count} data-testid="browser-import-history-clear"
        onClick={() => void run(async () => {
          setStatus(await window.ade.invoke('browserImport:clearHistory'))
          toast({ tone: 'success', message: t('browserImport.history.cleared') })
        })}>{t('browserImport.history.clear')}</Button>
    </div>
    {sources && <div data-testid="browser-import-history-sources">
      {sources.length === 0 && <p className="st-note">{t('browserImport.history.none')}</p>}
      {sources.map((source) => <div key={source.key} className="st-row">
        <span className="st-row__label">{source.browser}{source.profile ? <span className="st-note"> — {source.profile}</span> : null}</span>
        <Button variant="ghost" icon={<History size={14} strokeWidth={1.5} />} disabled={busy} onClick={() => void run(async () => {
          const result = await window.ade.invoke('browserImport:importHistory', source.key)
          setStatus(result.status)
          toast({ tone: 'success', message: t('browserImport.history.imported', { count: result.read, browser: source.browser }) })
        })}>{t('browserImport.history.import')}</Button>
      </div>)}
    </div>}
  </div>
}
