import { isOrganizeRunnerId, RECOMMENDED_ORGANIZE_PROVIDER, type OrganizeRunnerId } from '@shared/aiProviders'
import type { ReviewData } from '@shared/review'
import { errorMessage } from './errors'
import type { useT } from './i18n'

/** 取り込んだレビューを開くよう App に頼む（App が指摘の候補を開く） */
export const OPEN_REVIEW_EVENT = 'ade:open-review'

export function openImportedReview(review: ReviewData): void {
  window.dispatchEvent(new CustomEvent<ReviewData>(OPEN_REVIEW_EVENT, { detail: review }))
}

/** 設定の整理のモデル（無ければおすすめ） */
export async function organizeRunner(): Promise<OrganizeRunnerId> {
  try {
    const s = await window.ade.invoke('app:settings')
    if (isOrganizeRunnerId(s.organizer?.runner)) return s.organizer.runner
  } catch {
    // 既定（おすすめ）のまま
  }
  return `api:${RECOMMENDED_ORGANIZE_PROVIDER}`
}

/**
 * mtg・共有リンクから取り込んだ下書きのレビューを仕上げる：発話から指摘の候補を作り（整理）、判定モデルが有効なら点を付ける。
 * どちらも使えなければ下書きのまま返し、理由を notes に入れる
 */
export async function finishImportedReview(review: ReviewData, runner: OrganizeRunnerId, t: ReturnType<typeof useT>): Promise<{ review: ReviewData; notes: string[] }> {
  const notes: string[] = []
  let out = review
  try {
    if (out.canOrganize) out = await window.ade.invoke('review:organize', out.id, runner)
  } catch (err) {
    notes.push(t('meeting.organizeSkipped', { reason: errorMessage(err) }))
  }
  try {
    const scored = await window.ade.invoke('meeting:score', out.id)
    out = scored.review
    if (scored.result.skipped) notes.push(t('meeting.scoreSkipped', { reason: scored.result.skipped }))
    else notes.push(t('meeting.scored', { scored: scored.result.scored, excluded: scored.result.excluded }))
  } catch (err) {
    notes.push(t('meeting.scoreSkipped', { reason: errorMessage(err) }))
  }
  return { review: out, notes }
}
