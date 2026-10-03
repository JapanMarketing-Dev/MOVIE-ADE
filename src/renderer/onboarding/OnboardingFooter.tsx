import { ChevronLeft, CornerDownLeft } from 'lucide-react'
import { Button } from '../ui'
import { useT } from '../lib/i18n'

/**
 * セットアップの下の帯。左に「セットアップを閉じる」、右に 戻る／この手順を飛ばす／次へ。
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/OnboardingFooter.tsx（MIT）
 */
export function OnboardingFooter({ stepIndex, last, skippable, shortcutLabel, onSkipSetup, onBack, onSkipStep, onNext }: {
  stepIndex: number
  last: boolean
  skippable: boolean
  /** ⌘ / Ctrl。次へのボタンに ⌘↩ の印を出す */
  shortcutLabel: string
  onSkipSetup: () => void
  onBack: () => void
  onSkipStep: () => void
  onNext: () => void
}) {
  const t = useT()
  return (
    <footer className="ob-footer">
      <Button variant="ghost" onClick={onSkipSetup} data-testid="onboarding-skip-setup">{t('onboarding.footer.skipSetup')}</Button>
      <div className="ob-footer__actions">
        {stepIndex > 0 && <Button icon={<ChevronLeft size={14} />} onClick={onBack} data-testid="onboarding-back">{t('onboarding.footer.back')}</Button>}
        {skippable && <Button variant="ghost" onClick={onSkipStep} data-testid="onboarding-skip-step">{t('onboarding.footer.skipStep')}</Button>}
        <Button variant="primary" onClick={onNext} data-testid="onboarding-next">
          {t(last ? 'onboarding.footer.finish' : 'onboarding.footer.continue')}
          <kbd className="ob-footer__kbd" aria-hidden="true">{shortcutLabel}<CornerDownLeft size={11} /></kbd>
        </Button>
      </div>
    </footer>
  )
}
