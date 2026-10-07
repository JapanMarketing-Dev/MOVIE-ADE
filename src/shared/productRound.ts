import type { Project } from './types'

/**
 * プロダクトの巡回（オーケストラ）。複数のプロダクトを1人で順に見て回り、終わったプロダクトから Agent に渡す。
 * - 録画の巡回（record）: プロダクトごとに確認先を開き、声とペンで録る。止めるとそのレビューを Agent に渡して次のプロダクトへ
 * - 確認の巡回（confirm）: 全プロダクトの確認待ち（before / after）を、プロダクトごとに順に確かめる。そのレビューの確認待ちが
 *   無くなったら次へ
 * 渡したプロダクトの Agent はその間に並行して直す（全体の Agent が各プロダクトの subagent に任せる）。
 * 画面に依存しない純粋な処理だけを置く（進めるのは src/renderer/hooks/useProductRound.ts）。
 */

export type RoundKind = 'record' | 'confirm'

export interface RoundStep {
  projectId: string
  /** 確認の巡回で開くレビュー */
  reviewId?: string
}

export interface ProductRound {
  kind: RoundKind
  steps: RoundStep[]
  index: number
  /** 録画の巡回で Agent に渡したレビューの数 */
  sent: number
}

/** 巡回に入れるプロダクト（全体・以前のオーケストレーター・SSH は除く）。並びはサイドバーの順 */
export function roundProducts(projects: readonly Project[]): Project[] {
  return projects.filter((p) => !p.editorWorkspace && !p.orchestrator && p.source !== 'ssh')
}

export function recordRound(projects: readonly Project[], only?: readonly string[]): ProductRound | null {
  const steps = roundProducts(projects).filter((p) => !only || only.includes(p.id)).map((p) => ({ projectId: p.id }))
  return steps.length ? { kind: 'record', steps, index: 0, sent: 0 } : null
}

export interface PendingReview {
  projectId: string
  reviewId: string
  /** 確認待ちの指摘の数 */
  count: number
}

/** 確認の巡回。確認待ちのあるレビューを、プロダクトの並び → 新しいレビューの順に */
export function confirmRound(pending: readonly PendingReview[], projectOrder: readonly string[]): ProductRound | null {
  const rank = (id: string) => {
    const i = projectOrder.indexOf(id)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const steps = pending
    .filter((p) => p.count > 0)
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => rank(a.projectId) - rank(b.projectId) || a.i - b.i)
    .map((p) => ({ projectId: p.projectId, reviewId: p.reviewId }))
  return steps.length ? { kind: 'confirm', steps, index: 0, sent: 0 } : null
}

export function currentStep(round: ProductRound | null): RoundStep | null {
  return round ? round.steps[round.index] ?? null : null
}

/** 次のプロダクトへ。最後なら null（巡回の終わり） */
export function nextRound(round: ProductRound, sentNow = false): ProductRound | null {
  const sent = round.sent + (sentNow ? 1 : 0)
  return round.index + 1 < round.steps.length ? { ...round, index: round.index + 1, sent } : null
}

/** 確認の巡回で、開いているレビューの確認待ちが無くなったか */
export function confirmStepDone(progress: Record<string, { status?: string } | string | undefined> | undefined, includedIds: readonly string[]): boolean {
  const statusOf = (v: { status?: string } | string | undefined) => (typeof v === 'string' ? v : v?.status)
  return !includedIds.some((id) => statusOf(progress?.[id]) === 'human_review')
}
