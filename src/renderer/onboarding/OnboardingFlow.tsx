import { useCallback, useEffect, useRef, useState } from 'react'
import { ONBOARDING_STEPS, type OnboardingPatch, type OnboardingState, type OnboardingStepId } from '@shared/onboarding'
import type { AgentPreferences, ProjectsState } from '@shared/types'
import { PRODUCT_NAME, type TranslationKey } from '@shared/i18n'
import { Logo, Modal } from '../ui'
import { useT } from '../lib/i18n'
import { AgentsStep, AppearanceStep, FinishStep, PermissionsStep, ProjectStep, VoiceStep, type OnboardingVoice } from './OnboardingSteps'
import { OnboardingFooter } from './OnboardingFooter'
import { OnboardingSkipConfirmationDialog } from './OnboardingSkipConfirmationDialog'
import {
  LAST_STEP_INDEX,
  clampStepIndex,
  completePatch,
  dismissPatch,
  initialStepIndex,
  isContinueShortcut,
  isSkippableStep,
  nextStepIndex,
  previousStepIndex,
  stepIdAt,
  stepPatch
} from './onboardingFlowState'
import '../styles/onboarding.css'

/**
 * 初回起動のセットアップ（オンボーディング）。ウインドウ全体を覆う手順の画面。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/OnboardingFlow.tsx（MIT）。
 *   上の手順の目盛り（押すとその手順へ移る）・「n / 全体」・見出しと説明・下の帯（OnboardingFooter）、
 *   Esc で「閉じますか？」を出す、⌘↩ / Ctrl+Enter で次へ進む、の形をそのまま持ってきた。
 * Orca の telemetry・既定の Agent の YOLO 切り替え・通知・GitHub 連携の手順は持ち込んでいない。
 *
 * 手順を移るたびに再開位置（lastStep）を保存し、途中で終了しても同じ手順から再開する。
 * 内蔵ブラウザのビューは DOM の上に重なるので、開いている間は呼び出し側（App）がビューを隠す。
 */
export function OnboardingFlow({ onboarding, onPersist, agents, onAgentsChange, projects, voice }: {
  onboarding: OnboardingState | null
  /**
   * 進み具合を反映する。呼び出し側（App）が画面の状態をすぐ変えて保存は裏で行うので、
   * 完了・閉じるはこの呼び出しだけで閉じる（保存の成否を待たない。待つと保存の失敗で閉じなくなる）
   */
  onPersist: (patch: OnboardingPatch) => void
  agents: AgentPreferences
  onAgentsChange: (next: AgentPreferences) => void
  projects: ProjectsState
  voice: OnboardingVoice
}) {
  const t = useT()
  const [stepIndex, setStepIndex] = useState(() => initialStepIndex(onboarding))
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false)
  const stepId = stepIdAt(stepIndex)
  const last = stepIndex === LAST_STEP_INDEX
  const mac = window.ade.platform === 'darwin'

  const goTo = useCallback((index: number) => {
    const next = clampStepIndex(index)
    setStepIndex(next)
    onPersist(stepPatch(next))
  }, [onPersist])

  // 待たずに閉じる。同じ値を2回送っても結果は変わらない（⌘↩ の連打など）ので、押せなくなる印は持たない
  const close = useCallback((patch: OnboardingPatch) => onPersist(patch), [onPersist])

  const next = useCallback(() => {
    const index = nextStepIndex(stepIndex)
    if (index === null) {
      // 最後まで見たので、クラッシュレポートの初回の案内（CrashReportNotice）はもう出さない
      void window.ade.invoke('telemetry:noticeShown').catch(() => undefined)
      close(completePatch(new Date().toISOString()))
    } else goTo(index)
  }, [stepIndex, goTo, close])

  const back = useCallback(() => goTo(previousStepIndex(stepIndex)), [stepIndex, goTo])
  const skipSetup = useCallback(() => {
    setSkipConfirmOpen(false)
    close(dismissPatch(new Date().toISOString()))
  }, [close])

  // 初めて開いたときの手順も再開位置として書いておく（どこまで見たかを残す）
  useEffect(() => {
    if (!onboarding?.lastStep) onPersist(stepPatch(stepIndex))
    // 開いたときに1度だけ
  }, [])

  // ⌘↩ / Ctrl+Enter で次へ。入力中の欄の Enter は奪わない（Orca の isEditableTarget と同じ）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (skipConfirmOpen || !isContinueShortcut(event, mac)) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      event.preventDefault()
      next()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [next, skipConfirmOpen, mac])

  // 手順を移ったら、見出しへフォーカスを移す（読み上げで新しい手順が分かるように）
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { headingRef.current?.focus() }, [stepIndex])

  const stepLabel = (id: OnboardingStepId) => t(`onboarding.step.${id}` as TranslationKey)
  return <>
    {/* Esc はネイティブの dialog の cancel で受け、「閉じますか？」を出す */}
    <Modal className="ob-overlay" label={t('onboarding.dialogLabel')} onClose={() => setSkipConfirmOpen(true)}>
      <section className="ob-panel" data-testid="onboarding" data-step={stepId}>
        <div className="ob-drag" aria-hidden="true" />
        <header className="ob-brand"><Logo size={22} /><span>{PRODUCT_NAME}</span></header>

        <div className="ob-progress">
          {ONBOARDING_STEPS.map((id, index) => (
            <button key={id} type="button" className="ob-progress__bar" data-state={index === stepIndex ? 'active' : index < stepIndex ? 'done' : 'todo'}
              aria-current={index === stepIndex ? 'step' : undefined} title={stepLabel(id)}
              aria-label={t('onboarding.goToStep', { n: index + 1, label: stepLabel(id) })} onClick={() => goTo(index)} />
          ))}
          <span className="ob-progress__count">{t('onboarding.stepCount', { current: stepIndex + 1, total: ONBOARDING_STEPS.length })}</span>
        </div>

        <div className="ob-heading">
          {stepIndex === 0 && <div className="ob-eyebrow">{t('onboarding.welcome')}</div>}
          <h1 ref={headingRef} tabIndex={-1} className="ob-title">{t(`onboarding.${stepId}.title` as TranslationKey)}</h1>
          <p className="ob-subtitle">{t(`onboarding.${stepId}.subtitle` as TranslationKey)}</p>
        </div>

        <div className="ob-body">
          {stepId === 'appearance' && <AppearanceStep />}
          {stepId === 'agents' && <AgentsStep agents={agents} onAgentsChange={onAgentsChange} />}
          {stepId === 'project' && <ProjectStep projects={projects} />}
          {stepId === 'voice' && <VoiceStep voice={voice} />}
          {stepId === 'permissions' && <PermissionsStep />}
          {stepId === 'finish' && <FinishStep />}
        </div>

        <OnboardingFooter stepIndex={stepIndex} last={last} skippable={isSkippableStep(stepIndex)} shortcutLabel={mac ? '⌘' : 'Ctrl'}
          onSkipSetup={() => setSkipConfirmOpen(true)} onBack={back} onSkipStep={next} onNext={next} />
      </section>
    </Modal>
    {/* 外側の dialog の中に入れると、Esc の cancel が外側にも届いてしまうので並べて置く */}
    {skipConfirmOpen && <OnboardingSkipConfirmationDialog onSkip={skipSetup} onKeepGoing={() => setSkipConfirmOpen(false)} />}
  </>
}
