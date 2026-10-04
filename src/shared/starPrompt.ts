/**
 * 「GitHub で star を」のお願い（Orca の star-nag を小さくしたもの）。
 *
 * Orca由来: ~/bench/orca/src/main/star-nag/service.ts, threshold-trigger.ts, agent-value-moment.ts（MIT, Copyright 2026 Lovecast Inc.）
 *   - 成功した直後の「良い場面」にだけ出す（Orca は onboarding 完了・Agent の完了・使った回数のしきい値）
 *   - 閉じたら 3 日は出さない（STAR_NAG_COOLDOWN_DAYS）
 *   - star 済み・「今後表示しない」で二度と出さない（starNagCompleted）
 *   - star 済みかは gh で確かめ、gh が使えなければブラウザで開く案内にする（mode: 'gh' | 'web'）
 * Orca の結果の送信（star_nag_outcome などのテレメトリ）は持ち込まない。
 *
 * Ferret では、録画中とセットアップ（オンボーディング）中は出さず、生涯の表示回数にも上限を置く。
 */

export const STAR_REPO = { owner: 'JapanMarketing-Dev', repo: 'ferret' } as const
export const STAR_REPO_URL = `https://github.com/${STAR_REPO.owner}/${STAR_REPO.repo}`

/** 一度出したら、次に出せるまでの間（Orca と同じ 3 日） */
export const STAR_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000
/** 生涯で出す回数の上限 */
export const STAR_PROMPT_MAX_SHOWS = 3
/** 完成したレビューの数がこの値に達したときに出す（Orca の「しきい値を倍にしていく」を固定の段にしたもの） */
const STAR_PROMPT_REVIEW_MILESTONES: readonly number[] = [3, 10, 30]

/** state.json に置く状態。設定ではないので settings.json には出さない */
export interface StarPromptState {
  /** star した・「今後表示しない」を選んだ・すでに star 済みと分かった。true なら二度と出さない */
  done: boolean
  /** 出した回数 */
  count: number
  /** 最後に出した時刻（ms） */
  lastShownAt: number | null
  /** Agent への送信が成功した回数 */
  sends: number
  /** 完成したレビューの数 */
  reviews: number
  /** 「使いづらいところはありましたか？」を一度出した（フィードバックの声かけ。一度だけ） */
  feedbackAsked?: boolean
}

export const DEFAULT_STAR_PROMPT: StarPromptState = { done: false, count: 0, lastShownAt: null, sends: 0, reviews: 0 }

/** 保存された値を型どおりに直す。壊れていれば undefined（＝既定として扱う） */
export function sanitizeStarPrompt(raw: unknown): StarPromptState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)
  return {
    done: r.done === true,
    count: count(r.count),
    lastShownAt: typeof r.lastShownAt === 'number' && Number.isFinite(r.lastShownAt) ? r.lastShownAt : null,
    sends: count(r.sends),
    reviews: count(r.reviews),
    ...(r.feedbackAsked === true ? { feedbackAsked: true } : {})
  }
}

/** お願いを出してよい場面 */
export type StarPromptMoment = 'first-send' | 'reviews'

/** 出す・出さないに関わる、その時点の画面の状態 */
export interface StarPromptContext {
  now: number
  recording: boolean
  /** セットアップを終えた（または閉じた）か。終えるまでは出さない */
  onboardingDone: boolean
}

/** その出来事で「良い場面」になったか（数えたあとの状態で判定する） */
export function isMoment(state: StarPromptState, moment: StarPromptMoment): boolean {
  if (moment === 'first-send') return state.sends === 1
  return STAR_PROMPT_REVIEW_MILESTONES.includes(state.reviews)
}

/** 場面に関わらず、いま出してよいか。出さない理由を返す（null なら出してよい） */
export function blockedReason(state: StarPromptState, ctx: StarPromptContext): 'done' | 'cap' | 'cooldown' | 'recording' | 'onboarding' | null {
  if (state.done) return 'done'
  if (state.count >= STAR_PROMPT_MAX_SHOWS) return 'cap'
  if (state.lastShownAt !== null && ctx.now - state.lastShownAt < STAR_PROMPT_COOLDOWN_MS) return 'cooldown'
  if (ctx.recording) return 'recording'
  if (!ctx.onboardingDone) return 'onboarding'
  return null
}

/** 出来事を数える */
export function countEvent(state: StarPromptState, moment: StarPromptMoment): StarPromptState {
  return moment === 'first-send' ? { ...state, sends: state.sends + 1 } : { ...state, reviews: state.reviews + 1 }
}

/** Agent への送信がこの回数に達したら、一度だけフィードバックを聞く（star のお願いの最初の場面＝1回目とは重ねない） */
export const FEEDBACK_ASK_AFTER_SENDS = 3

/** フィードバックの声かけを出してよいか。録画中・セットアップ中は出さない。一度出したら二度と出さない */
export function shouldAskFeedback(state: StarPromptState, ctx: Omit<StarPromptContext, 'now'>): boolean {
  return !state.feedbackAsked && state.sends >= FEEDBACK_ASK_AFTER_SENDS && !ctx.recording && ctx.onboardingDone
}

/** トーストの出し方。gh で直接 star できるか、ブラウザで開くか */
export type StarPromptMode = 'gh' | 'web'

/** 押したときの結果 */
export type StarActionResult = 'starred' | 'opened' | 'failed'
