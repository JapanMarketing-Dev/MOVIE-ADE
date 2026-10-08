import type { Project } from './types'

/**
 * 確認の巡回（オーケストラ）。全プロダクトの確認待ち（before / after）を、プロダクトごとに順に確かめる。
 * 人が「次へ」を押したときだけ進む（自動では進まない）。
 * 録画の巡回（止めるたびに次のプロダクトへ進む形）は 0.6.5 で無くした。録画は全体のフィードバックの画面で1回のまま、
 * 帯のタブでプロダクトを切り替えると、その間の指摘の宛先も切り替わる（@shared/productSplit）。
 * 画面に依存しない純粋な処理だけを置く（進めるのは src/renderer/hooks/useProductRound.ts）。
 */

export type RoundKind = 'confirm'

export interface RoundStep {
  projectId: string
  /** 確認の巡回で開くレビュー */
  reviewId?: string
}

export interface ProductRound {
  kind: RoundKind
  steps: RoundStep[]
  index: number
  sent: number
}

/** オーケストラのプロダクト（全体・以前のオーケストレーター・オーケストラの対象外・SSH は除く）。並びはサイドバーの順 */
export function roundProducts(projects: readonly Project[]): Project[] {
  return projects.filter((p) => !p.editorWorkspace && !p.orchestrator && !p.orchestraExcluded && p.source !== 'ssh')
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
