import { ONBOARDING_STEPS, type OnboardingPatch, type OnboardingState, type OnboardingStepId } from '@shared/onboarding'

/**
 * セットアップの手順の進め方（画面に依存しない純粋な関数。単体テストの対象）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/onboarding-flow-state.ts の
 *           resolveStepIndex（範囲に収める・再開位置を決める）と、
 *           use-onboarding-flow-persistence.ts の closeWith（完了／途中で閉じたときに書く値）（MIT）。
 * Orca の「OS によって飛ばす手順」や手順番号の読み替え（flowVersion）は持ち込んでいない。
 */

/** 何も設定しなくても先へ進めてよい手順（フッターに「この手順を飛ばす」を出す） */
export const SKIPPABLE_STEPS: ReadonlySet<OnboardingStepId> = new Set<OnboardingStepId>(['project', 'voice'])

export const LAST_STEP_INDEX = ONBOARDING_STEPS.length - 1

export function clampStepIndex(index: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(Math.trunc(index), 0), LAST_STEP_INDEX)
}

export function stepIdAt(index: number): OnboardingStepId {
  return ONBOARDING_STEPS[clampStepIndex(index)]!
}

/** 開いたときの手順。途中で終了した人は最後に見ていた手順から再開する */
export function initialStepIndex(state: OnboardingState | null | undefined): number {
  const index = state?.lastStep ? ONBOARDING_STEPS.indexOf(state.lastStep) : -1
  return index < 0 ? 0 : index
}

/** 次の手順。最後の手順なら null（＝完了） */
export function nextStepIndex(index: number): number | null {
  const current = clampStepIndex(index)
  return current >= LAST_STEP_INDEX ? null : current + 1
}

export function previousStepIndex(index: number): number {
  return clampStepIndex(clampStepIndex(index) - 1)
}

export function isSkippableStep(index: number): boolean {
  return SKIPPABLE_STEPS.has(stepIdAt(index))
}

/** 手順を移ったときに書く値（再開位置） */
export function stepPatch(index: number): OnboardingPatch {
  return { lastStep: stepIdAt(index) }
}

/** 最後まで進んだ。再開位置は消す */
export function completePatch(now: string): OnboardingPatch {
  return { completedAt: now, dismissedAt: null, lastStep: null }
}

/** 途中で閉じた。もう一度開いたときは先頭から（Orca の dismissed と同じ） */
export function dismissPatch(now: string): OnboardingPatch {
  return { dismissedAt: now, lastStep: null }
}

/** ヘルプや設定から開き直す。済んだ印を消し、先頭から始める（Orca の showOnboardingFromRenderer） */
export function reopenPatch(): OnboardingPatch {
  return { completedAt: null, dismissedAt: null, lastStep: null }
}

/**
 * 「進む」のショートカット（⌘↩ / Ctrl+Enter）。入力欄で打っている Enter は奪わない。
 * Orca由来: ~/bench/orca/src/renderer/src/lib/screen-submit-shortcut.ts の isScreenSubmitShortcut（MIT）
 */
export function isContinueShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
