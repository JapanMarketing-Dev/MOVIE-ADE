import { useEffect, useState } from 'react'
import { FileUp, History, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { BrowserImportStatus, HistorySourceInfo, PasswordExportFile } from '@shared/browserImport'
import { Button, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'

/**
 * 設定のページの「ブラウザから取り込む」。ほかのブラウザで書き出したパスワードの CSV と、Chrome・Edge・Brave・Arc・Safari の履歴を取り込む。
 * CSV の選択（ダイアログ）・履歴の元は main が決める。画面からはパスを送らない（一覧に出ている元の key を返すだけ）。
 * 画面に出すのは件数だけ（パスワード・ユーザー名の一覧は出さない）。
 * 同期：ダウンロード・デスクトップにある新しい書き出しを見つけて出し、押すとその CSV で取り込み直す（同じブラウザから前に取り込んだものは置き換わる）。
 * 取り込んだ CSV は平文なので、ごみ箱へ移すボタンを出す
 */
export function BrowserImportSection() {
  const t = useT()
  const toast = useToast()
  const [status, setStatus] = useState<BrowserImportStatus | null>(null)
  const [sources, setSources] = useState<HistorySourceInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  /** この画面で取り込んだ CSV（key。ごみ箱へ移すまで案内とボタンを出し続ける） */
  const [csvImported, setCsvImported] = useState<string | null>(null)
  const [exports, setExports] = useState<PasswordExportFile[]>([])

  const findExports = () => void window.ade.invoke('browserImport:findExports').then(setExports).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  useEffect(() => {
    void window.ade.invoke('browserImport:status').then(setStatus).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    findExports()
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

  const importPasswords = (key?: string) => void run(async () => {
    const result = await window.ade.invoke('browserImport:importPasswords', key)
    if (!result) return
    setStatus(await window.ade.invoke('browserImport:status'))
    toast({ tone: 'success', message: t('browserImport.passwords.importedSync', { added: result.added, updated: result.updated, removed: result.removed, skipped: result.skipped }) })
    // 書き出した CSV は平文。取り込んだらごみ箱へ移してもらう（トーストは消えるので、節の中に出し続ける）
    setCsvImported(result.file)
  })
  const trashCsv = () => void run(async () => {
    if (!csvImported) return
    if (await window.ade.invoke('browserImport:trashExport', csvImported)) toast({ tone: 'success', message: t('browserImport.passwords.trashed') })
    setCsvImported(null)
    findExports()
  })

  return <div id="settings-browser-import" className="st-page__group" data-testid="browser-import-settings">
    <p className="st-note">{t('browserImport.intro')}</p>

    <h3 className="st-page__subheading">{t('browserImport.passwords.title')}</h3>
    <p className="st-note">{t('browserImport.passwords.howTo')}</p>
    <p className="st-note">{t('browserImport.passwords.syncNote')}</p>
    {exports.length > 0 && <div data-testid="browser-import-exports">
      <p className="st-note">{t('browserImport.passwords.found')}</p>
      {exports.map((file) => <div key={file.key} className="st-row">
        <span className="st-row__label">{file.name}<span className="st-note"> — {new Date(file.modifiedAt).toLocaleString()}</span></span>
        <Button variant="ghost" icon={<RefreshCw size={14} strokeWidth={1.5} />} disabled={busy} onClick={() => importPasswords(file.key)} data-testid="browser-import-export">{t('browserImport.passwords.importFound')}</Button>
      </div>)}
    </div>}
    <div className="st-row">
      <span className="st-row__label" data-testid="browser-import-password-count">{t('browserImport.passwords.count', { count: status?.passwords.count ?? 0 })}</span>
    </div>
    {csvImported && <div className="st-row" data-testid="browser-import-delete-csv">
      <p className="st-note st-note--warn">{t('browserImport.passwords.deleteCsv')}</p>
      <Button variant="ghost" icon={<Trash2 size={14} strokeWidth={1.5} />} disabled={busy} onClick={trashCsv} data-testid="browser-import-trash-csv">{t('browserImport.passwords.trashCsv')}</Button>
    </div>}
    {status && !status.passwords.persisted && <p className="st-note st-note--warn">{t('browserImport.passwords.notPersisted')}</p>}
    <div className="st-row st-row--buttons">
      <Button icon={<FileUp size={14} strokeWidth={1.5} />} disabled={busy} data-testid="browser-import-passwords" onClick={() => importPasswords()}>{t('browserImport.passwords.import')}</Button>
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
