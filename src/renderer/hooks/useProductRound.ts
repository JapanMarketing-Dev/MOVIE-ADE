import { useCallback, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { confirmRound, currentStep, nextRound, type ProductRound } from '@shared/productRound'

/**
 * 確認の巡回（オーケストラ。@shared/productRound）を進める。全プロダクトの確認待ちのレビューを順に開く。
 * 自動では次へ進まない（人が「次へ」を押したときだけ進む）。
 * 録画は巡回にしない：全体のフィードバックの画面で1回の録画のまま、帯のタブでプロダクトを切り替える（App の recordAll）
 */
export function useProductRound(opts: {
  projects: readonly Project[]
  /** そのプロダクトへ切り替えて、そのレビューを指摘の画面で開く */
  openReview: (projectId: string, reviewId: string) => Promise<void>
  /** 終わったら全体（すべてのプロダクト）へ戻る */
  openOverview: () => void
  notify: (tone: 'success' | 'info' | 'warning', message: string) => void
  messages: { confirmDone: () => string; nothingToConfirm: () => string }
}): {
  round: ProductRound | null
  start: () => Promise<void>
  skip: () => void
  stop: () => void
} {
  const [round, setRound] = useState<ProductRound | null>(null)
  const roundRef = useRef(round)
  roundRef.current = round
  const optsRef = useRef(opts)
  optsRef.current = opts

  const start = useCallback(async () => {
    const o = optsRef.current
    const pending = await window.ade.invoke('review:pendingAcross')
    const r = confirmRound(pending, o.projects.map((p) => p.id))
    if (!r) { o.notify('info', o.messages.nothingToConfirm()); return }
    setRound(r)
    const step = r.steps[0]!
    await o.openReview(step.projectId, step.reviewId!)
  }, [])

  const skip = useCallback(() => {
    const r = roundRef.current
    if (!r) return
    const next = nextRound(r)
    setRound(next)
    const step = currentStep(next)
    if (!next || !step?.reviewId) {
      optsRef.current.notify('success', optsRef.current.messages.confirmDone())
      optsRef.current.openOverview()
      return
    }
    void optsRef.current.openReview(step.projectId, step.reviewId)
  }, [])

  const stop = useCallback(() => setRound(null), [])

  return { round, start, skip, stop }
}
