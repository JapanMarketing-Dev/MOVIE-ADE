import { isOnboardingStepId, type OnboardingStepId } from '@shared/onboarding'

/**
 * App の外（設定のページなど）からセットアップを開き直すためのイベント。
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/show-onboarding-event.ts（MIT）。
 * Orca はここで保存まで行うが、本システムでは状態を持つ App が受けて保存する（ヘルプメニューと同じ経路にする）。
 */

const SHOW_ONBOARDING_EVENT = 'ade:show-onboarding'

/**
 * step を渡すとその手順から開く（チェックリストの「設定する」）。ボタンの onClick にそのまま渡されても
 * クリックのイベントを手順と取り違えないよう、手順の id だけを受け取る
 */
export function requestShowOnboarding(step?: unknown): void {
  window.dispatchEvent(new CustomEvent<{ step?: OnboardingStepId }>(SHOW_ONBOARDING_EVENT, { detail: isOnboardingStepId(step) ? { step } : {} }))
}

export function onShowOnboardingRequested(callback: (step?: OnboardingStepId) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<{ step?: OnboardingStepId } | undefined>).detail?.step)
  window.addEventListener(SHOW_ONBOARDING_EVENT, listener)
  return () => window.removeEventListener(SHOW_ONBOARDING_EVENT, listener)
}
