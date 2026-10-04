import { ONBOARDING_STEPS, type OnboardingPatch, type OnboardingState, type OnboardingStepId } from '@shared/onboarding'
import type { BuiltinAgent } from '@shared/types'
import { BUILTIN_AGENTS } from '@shared/agentCatalog'
import { resolveDecision, type DecisionPreferences, type DecisionPreset } from '@shared/decision'

/**
 * セットアップの手順の進め方（画面に依存しない純粋な関数。単体テストの対象）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/onboarding-flow-state.ts の
 *           resolveStepIndex（範囲に収める・再開位置を決める）と、
 *           use-onboarding-flow-persistence.ts の closeWith（完了／途中で閉じたときに書く値）（MIT）。
 * Orca の「OS によって飛ばす手順」や手順番号の読み替え（flowVersion）は持ち込んでいない。
 */

/** 何も設定しなくても先へ進めてよい手順（フッターに「この手順を飛ばす」を出す） */
const SKIPPABLE_STEPS: ReadonlySet<OnboardingStepId> = new Set<OnboardingStepId>(['decision', 'project', 'voice'])

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

/**
 * 最初の画面に出す製品の考え方（3段）と、最後の手順の流れ。並びと文言キーをここで持つ（単体テストで全言語にあるかを見る）。
 *   1. 印（ペン・四角の枠）と声をテキストにして、大量のフィードバックを的確に Agent へ伝える
 *   2. オンライン・オフラインの会議でもその場で録れる
 *   3. できたかを利用者の判定モデルで Agent が確かめる（Agent が期待どおりに動いたかを定義する）
 */
export const ONBOARDING_CONCEPT_KEYS = ['onboarding.concept.feedback', 'onboarding.concept.meetings', 'onboarding.concept.decision'] as const

export const FINISH_STEP_KEYS = ['onboarding.finish.step1', 'onboarding.finish.step2', 'onboarding.finish.meetings',
  'onboarding.finish.step3', 'onboarding.finish.step4', 'onboarding.finish.decision'] as const

// ───────────────────────── Agent の手順：どれか1つを選ぶ ─────────────────────────

/**
 * 最初から選んでおくおすすめの Agent。まだ何も選んでいないときだけ、インストール済みのうち
 * カタログの順（Claude Code → Codex → …）で最初のものを返す。無ければ null
 */
export function recommendedAgent(options: ReadonlyArray<{ id: string; installed: boolean; custom?: boolean }> | null, startupAgents: readonly string[]): BuiltinAgent | null {
  if (!options || startupAgents.length > 0) return null
  const installed = new Set(options.filter((o) => o.installed && !o.custom).map((o) => o.id))
  return BUILTIN_AGENTS.find((id) => installed.has(id)) ?? null
}

/**
 * 「次へ」を押したときの Agent の手順の判定。
 *   ok            … 1つ以上選んでいる
 *   needSelection … インストール済みがあるのに1つも選んでいない（進ませずに「少なくとも1つ選んで」と出す）
 *   noneInstalled … インストール済みが1つも無い（インストールの案内を出したうえで進ませる。行き止まりにしない）
 *   detecting     … 探している途中（待たせずに進ませる）
 */
type AgentsGate = 'ok' | 'needSelection' | 'noneInstalled' | 'detecting'

export function agentsStepGate(options: ReadonlyArray<{ installed: boolean; custom?: boolean }> | null, startupAgents: readonly string[]): AgentsGate {
  if (startupAgents.length > 0) return 'ok'
  if (!options) return 'detecting'
  return options.some((o) => o.installed && !o.custom) ? 'needSelection' : 'noneInstalled'
}

// ───────────────────────── 判定モデルの手順 ─────────────────────────

/** おすすめの提供元（設定の Decision model の節と同じ印を付ける）。端末内の Ollama（キー・料金なし。モデルは PC に合わせて選ぶ） */
export const RECOMMENDED_DECISION_PRESET: DecisionPreset = 'ollama'

/**
 * 判定モデルを有効にしてよいか（接続先が組み立てられ、キーが要るならキーがある）。
 * 足りないまま有効にすると、Agent への指示に「判定する」が入るのに呼べないので、揃ったときだけ有効にする
 */
export function decisionReady(prefs: DecisionPreferences, keyPresent: boolean): boolean {
  const resolved = resolveDecision(prefs)
  if (resolved.missing.length > 0) return false
  return resolved.authScheme === 'none' || keyPresent
}

/**
 * 手順の見出しの下の説明のキー。許可の手順の説明（「macOS では最初に1回だけ…」）は macOS だけのものなので、
 * Windows・Linux では「前もって求められない」の文にする
 */
export function stepSubtitleKey(stepId: OnboardingStepId, platform: string): string {
  if (stepId === 'permissions' && platform !== 'darwin') return 'onboarding.permissions.subtitleOther'
  return `onboarding.${stepId}.subtitle`
}
