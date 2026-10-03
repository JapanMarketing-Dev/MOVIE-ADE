import { FileWarning } from 'lucide-react'
import { Button, Modal } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 変更ありのファイルを閉じるときの確認（保存 / 保存しない / キャンセル）。
 * Orca由来: ~/bench/orca/src/renderer/src/components/use-terminal-editor-close-dialog-actions.ts（MIT）の
 * 3択の流れ。保存に失敗したら閉じない（呼び出し側の useOpenFiles.resolveClose）。
 *
 * 内蔵ブラウザのビューは DOM の上に重なるので、出している間は呼び出し側でビューを隠すこと。
 */
export function UnsavedChangesDialog({
  name,
  onChoose
}: {
  name: string
  onChoose: (choice: 'save' | 'discard' | 'cancel') => void
}) {
  const t = useT()
  return (
    <Modal className="rv-modal" label={t('unsaved.title')} onClose={() => onChoose('cancel')}>
      <div className="rv-modal__panel unsaved-dialog" data-testid="unsaved-dialog">
        <header className="rv-modal__head">
          <h2><FileWarning size={15} aria-hidden="true" />{t('unsaved.heading', { name })}</h2>
        </header>
        <p className="unsaved-dialog__body">{t('unsaved.body')}</p>
        <div className="unsaved-dialog__actions">
          <Button variant="ghost" onClick={() => onChoose('discard')} data-testid="unsaved-discard">{t('unsaved.discard')}</Button>
          <span className="editor-head__spacer" />
          <Button variant="ghost" onClick={() => onChoose('cancel')}>{t('common.cancel')}</Button>
          <Button variant="primary" autoFocus onClick={() => onChoose('save')} data-testid="unsaved-save">{t('common.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}
