import { useState, useSyncExternalStore } from 'react'
import { ClipboardCopy, X } from 'lucide-react'
import { Button, IconButton } from '../ui'
import { useT } from '../lib/i18n'
import { reportHandled } from '@shared/report'
import { getTerminal, programCopyNotice, setProgramCopy, subscribeProgramCopy } from '../terminal/terminalClient'

/**
 * 端末のプログラムのコピー（OSC 52）の帯（security-5 [9]）。ペインの下に出す。
 * - 確認（既定）: 何文字か・先頭の1行を見せ、［コピー］を押したときだけ main が写す（押した直後の操作でしか写せない）
 * - 常に許可で写したとき: 写したことを知らせ、［毎回確認する］で戻せる
 */
export function TerminalClipboardBar({ paneKey }: { paneKey: string }) {
  const t = useT()
  const notice = useSyncExternalStore(subscribeProgramCopy, () => programCopyNotice(paneKey))
  const [expired, setExpired] = useState(false)
  if (!notice && !expired) return null

  const close = () => {
    setExpired(false)
    setProgramCopy(paneKey, null)
    getTerminal(paneKey)?.focus()
  }
  const fail = (op: string) => (err: unknown) => reportHandled(err, { area: 'terminal', op })
  const accept = async (always: boolean) => {
    if (!notice) return
    if (always) await window.ade.invoke('settings:terminalClipboard', 'allow').catch(fail('allow program copies'))
    const copied = await window.ade.invoke('terminal:programCopyAccept', notice.ptyId).catch(fail('accept program copy'))
    if (copied) close()
    else {
      setProgramCopy(paneKey, null)
      setExpired(true)
    }
  }
  const dismiss = () => {
    if (notice?.result.kind === 'ask') void window.ade.invoke('terminal:programCopyDismiss', notice.ptyId).catch(fail('dismiss program copy'))
    close()
  }
  const askEachTime = () => {
    void window.ade.invoke('settings:terminalClipboard', 'ask').catch(fail('ask program copies'))
    close()
  }

  return (
    <div className="terminal-clipboard-bar" role="status" data-testid={`terminal-clipboard-bar-${paneKey}`} onMouseDown={(e) => e.stopPropagation()}>
      <ClipboardCopy size={14} aria-hidden="true" className="terminal-clipboard-bar__icon" />
      {expired || !notice ? (
        <span className="terminal-clipboard-bar__text">{t('terminal.programCopy.expired')}</span>
      ) : notice.result.kind === 'ask' ? (
        <>
          <span className="terminal-clipboard-bar__text">
            {t('terminal.programCopy.ask', { count: notice.result.chars })}
            {notice.result.preview && <code className="terminal-clipboard-bar__preview">{notice.result.preview}</code>}
          </span>
          <Button variant="primary" data-testid="terminal-clipboard-copy" onClick={() => void accept(false)}>{t('terminal.programCopy.copy')}</Button>
          <Button variant="ghost" data-testid="terminal-clipboard-always" onClick={() => void accept(true)}>{t('terminal.programCopy.always')}</Button>
        </>
      ) : (
        <>
          <span className="terminal-clipboard-bar__text">{t('terminal.programCopy.copied', { count: notice.result.chars })}</span>
          <Button variant="ghost" data-testid="terminal-clipboard-ask" onClick={askEachTime}>{t('terminal.programCopy.askEachTime')}</Button>
        </>
      )}
      <IconButton label={t('common.close')} icon={<X size={14} />} size="sm" onClick={dismiss} data-testid="terminal-clipboard-dismiss" />
    </div>
  )
}
