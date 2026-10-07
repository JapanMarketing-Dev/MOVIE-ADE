import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import type { ReviewData } from '@shared/review'
import { confirmRound, confirmStepDone, currentStep, nextRound, recordRound, type ProductRound, type RoundKind } from '@shared/productRound'

/**
 * プロダクトの巡回（オーケストラ。@shared/productRound）を進める。
 * - 録画の巡回: プロダクトごとに新しいレビューを始める → 止めたらそのレビューを Agent に渡し（プロダクトに Agent がいなければ
 *   全体の Agent が subagent に任せる）、次のプロダクトへ。渡した Agent は、次を見ている間に並行して直す
 * - 確認の巡回: 全プロダクトの確認待ちのレビューを順に開き、確認待ちが無くなったら次へ
 */
export function useProductRound(opts: {
  projects: readonly Project[]
  review: ReviewData | null
  /** そのプロダクトで新しいレビューを始める（切り替えてから録画。ページが無ければフィードバックの画面へ） */
  startReviewIn: (projectId: string) => void
  /** そのプロダクトへ切り替えて、そのレビューを指摘の画面で開く */
  openReview: (projectId: string, reviewId: string) => Promise<void>
  /** 終わったら全体（すべてのプロダクト）へ戻る */
  openOverview: () => void
  notify: (tone: 'success' | 'info' | 'warning', message: string) => void
  messages: { recordDone: (count: number) => string; confirmDone: () => string; nothingToConfirm: () => string; noProducts: () => string; sendFailed: (message: string) => string }
}): {
  round: ProductRound | null
  start: (kind: RoundKind) => Promise<void>
  /** 録画を止めた（review:ready）。録画の巡回なら Agent に渡して次へ */
  onReviewReady: (review: ReviewData) => void
  skip: () => void
  stop: () => void
} {
  const [round, setRound] = useState<ProductRound | null>(null)
  const roundRef = useRef(round)
  roundRef.current = round
  const optsRef = useRef(opts)
  optsRef.current = opts

  const go = useCallback((next: ProductRound | null, finished: (r: ProductRound) => void, from: ProductRound) => {
    setRound(next)
    const step = currentStep(next)
    if (!next || !step) { finished(from); return }
    // 切り替えと画面の描き直しを待ってから、次のプロダクトを始める
    setTimeout(() => {
      if (next.kind === 'record') optsRef.current.startReviewIn(step.projectId)
      else if (step.reviewId) void optsRef.current.openReview(step.projectId, step.reviewId)
    }, 300)
  }, [])

  const finishRecord = useCallback((r: ProductRound) => {
    optsRef.current.notify('success', optsRef.current.messages.recordDone(r.sent))
    optsRef.current.openOverview()
  }, [])
  const finishConfirm = useCallback(() => {
    optsRef.current.notify('success', optsRef.current.messages.confirmDone())
    optsRef.current.openOverview()
  }, [])

  const start = useCallback(async (kind: RoundKind) => {
    const o = optsRef.current
    if (kind === 'record') {
      const r = recordRound(o.projects)
      if (!r) { o.notify('info', o.messages.noProducts()); return }
      setRound(r)
      o.startReviewIn(r.steps[0]!.projectId)
      return
    }
    const pending = await window.ade.invoke('review:pendingAcross')
    const r = confirmRound(pending, o.projects.map((p) => p.id))
    if (!r) { o.notify('info', o.messages.nothingToConfirm()); return }
    setRound(r)
    const step = r.steps[0]!
    await o.openReview(step.projectId, step.reviewId!)
  }, [])

  const onReviewReady = useCallback((review: ReviewData) => {
    const r = roundRef.current
    if (!r || r.kind !== 'record') return
    const hasItems = review.document.items.some((it) => it.include)
    const advance = (sent: boolean) => go(nextRound(r, sent), finishRecord, { ...r, sent: r.sent + (sent ? 1 : 0) })
    if (!hasItems) { advance(false); return }
    // 止めたプロダクトのレビューを、そのまま Agent に渡す（全体の Agent が subagent に任せる）
    void window.ade.invoke('review:send', review.id, { target: { kind: 'auto' } })
      .then((result) => {
        if (!result.ok) optsRef.current.notify('warning', optsRef.current.messages.sendFailed(result.message))
        advance(result.ok)
      })
      .catch((err: unknown) => {
        optsRef.current.notify('warning', optsRef.current.messages.sendFailed(err instanceof Error ? err.message : String(err)))
        advance(false)
      })
  }, [go, finishRecord])

  // 確認の巡回：開いているレビューの確認待ちが無くなったら次へ
  const review = opts.review
  useEffect(() => {
    const r = roundRef.current
    const step = currentStep(r)
    if (!r || r.kind !== 'confirm' || !step || !review || review.id !== step.reviewId) return
    const included = review.document.items.filter((it) => it.include).map((it) => it.id)
    if (confirmStepDone(review.progress, included)) go(nextRound(r), finishConfirm, r)
  }, [review, go, finishConfirm])

  const skip = useCallback(() => {
    const r = roundRef.current
    if (!r) return
    go(nextRound(r), r.kind === 'record' ? finishRecord : finishConfirm, r)
  }, [go, finishRecord, finishConfirm])

  const stop = useCallback(() => setRound(null), [])

  return { round, start, onReviewReady, skip, stop }
}
