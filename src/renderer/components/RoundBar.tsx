import { ChevronRight, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { currentStep, type ProductRound } from '@shared/productRound'
import { useT } from '../lib/i18n'

/**
 * 巡回の帯（上部のバーの中央）。今どのプロダクトか・何番目か、「次へ」「終わる」。
 * 録画中の「次へ」は録画を止める（止めるとそのレビューを Agent に渡して次のプロダクトへ進む）
 */
export function RoundBar({ round, projects, recording, onNext, onStop }: {
  round: ProductRound
  projects: readonly Project[]
  recording: boolean
  onNext: () => void
  onStop: () => void
}) {
  const t = useT()
  const step = currentStep(round)
  const name = projects.find((p) => p.id === step?.projectId)?.name ?? ''
  return <div className="round-bar" role="status" data-testid="round-bar" data-kind={round.kind}>
    <span className="round-bar__label">{t(round.kind === 'record' ? 'round.recordLabel' : 'round.confirmLabel')}</span>
    <span className="round-bar__pos" data-testid="round-position">{round.index + 1}/{round.steps.length}</span>
    <span className="round-bar__name" title={name} data-testid="round-product">{name}</span>
    <button type="button" className="round-bar__btn" onClick={onNext} data-testid="round-next" title={t(recording ? 'round.nextWhileRecording' : 'round.next')}>
      {t(recording ? 'round.stopAndNext' : 'round.next')}<ChevronRight size={12} aria-hidden="true" />
    </button>
    <button type="button" className="round-bar__btn round-bar__btn--quiet" onClick={onStop} aria-label={t('round.stop')} title={t('round.stop')} data-testid="round-stop">
      <X size={12} aria-hidden="true" />
    </button>
  </div>
}
