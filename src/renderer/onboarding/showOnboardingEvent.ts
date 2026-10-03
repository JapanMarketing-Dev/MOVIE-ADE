/**
 * App の外（設定のページなど）からセットアップを開き直すためのイベント。
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/show-onboarding-event.ts（MIT）。
 * Orca はここで保存まで行うが、本システムでは状態を持つ App が受けて保存する（ヘルプメニューと同じ経路にする）。
 */

const SHOW_ONBOARDING_EVENT = 'ade:show-onboarding'

export function requestShowOnboarding(): void {
  window.dispatchEvent(new CustomEvent(SHOW_ONBOARDING_EVENT))
}

export function onShowOnboardingRequested(callback: () => void): () => void {
  window.addEventListener(SHOW_ONBOARDING_EVENT, callback)
  return () => window.removeEventListener(SHOW_ONBOARDING_EVENT, callback)
}
