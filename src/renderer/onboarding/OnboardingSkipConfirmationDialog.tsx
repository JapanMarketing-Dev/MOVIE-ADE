import { useEffect, useRef } from 'react'
import { Button, Modal } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 「セットアップを閉じますか？」。Esc・「セットアップを閉じる」で出す。
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/OnboardingSkipConfirmationDialog.tsx（MIT）
 * 既定のボタン（最初にフォーカスが当たる）は「続ける」にして、Enter の打ち間違いで閉じないようにする。
 */
export function OnboardingSkipConfirmationDialog({ onSkip, onKeepGoing }: { onSkip: () => void; onKeepGoing: () => void }) {
  const t = useT()
  const actionsRef = useRef<HTMLDivElement>(null)
  // Modal が showModal した後（子の effect が先に走る）にフォーカスを移す
  useEffect(() => actionsRef.current?.querySelector<HTMLButtonElement>('[data-default]')?.focus(), [])
  return (
    <Modal className="rv-modal" label={t('onboarding.skip.title')} onClose={onKeepGoing}>
      <div className="rv-modal__panel ob-skip" data-testid="onboarding-skip-confirm">
        <h2 className="ob-skip__title">{t('onboarding.skip.title')}</h2>
        <p className="ob-skip__text">{t('onboarding.skip.description')}</p>
        <div className="ob-skip__actions" ref={actionsRef}>
          <Button onClick={onSkip} data-testid="onboarding-skip-confirm-skip">{t('onboarding.skip.skip')}</Button>
          <Button data-default variant="primary" onClick={onKeepGoing}>{t('onboarding.skip.keepGoing')}</Button>
        </div>
      </div>
    </Modal>
  )
}
