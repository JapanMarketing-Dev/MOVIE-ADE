import type { FeedbackDocument } from '../main/pipeline/types'
import type { ProgressMap, ProgressPatchValue } from './findingProgress'
import { toTrimmedTime, type TrimCut } from './trim'

export interface ReviewSummary {
  id: string
  startedAt: string
  durationMs: number
  itemCount: number
  /** 進み具合の対象（Agent へ送る指摘。include=false は数えない）の件数 */
  includedCount?: number
  /** そのうち完了した件数（progress.json。@shared/findingProgress） */
  doneCount?: number
  /** Agent が人間へ戻した（確認待ち。needs_human）件数 */
  needsHumanCount?: number
  /** Agent が直して人の確認を待っている（human_review）件数 */
  humanReviewCount?: number
  targetUrl?: string
  incomplete: boolean
  /** 記録が壊れていて開けない */
  broken?: boolean
  /** 利用者が付けた名前（一覧の見出しに使う） */
  name?: string
  /** 指摘から自動で付けた名前（何系の修正か）。見出しは name → autoName → title の順 */
  autoName?: string
  /** 録ったページのタイトル（最初の遷移のもの） */
  title?: string
  /** 一覧から隠した（フィルタで表示できる） */
  archived?: boolean
  /** Agent へ送った時刻（ISO8601）。送っていなければ無い */
  sentAt?: string
  /** 検索用の本文（ページのタイトル・URL・指摘の見出しと要望と発話）。長い分は切ってある */
  searchText?: string
}

/** レビューの名前とアーカイブ（一覧の整理）。null の name は名前を外す */
export interface ReviewLabelPatch {
  name?: string | null
  archived?: boolean
}
export interface ReviewData {
  id: string
  document: FeedbackDocument
  images: Record<string, string>
  canUndo?: boolean
  canOrganize?: boolean
  videoUrl?: string
  warnings: string[]
  /** 指摘ごとの進み具合（progress.json）。書かれていない指摘は未対応 */
  progress?: ProgressMap
  /**
   * このレビューの録画の一覧（最初の録画＝1 と、あとから追記した録画）。追記していなければ無い。
   * 指摘の時刻は録画をつないだ1本の時間軸なので、再生には takeAt で録画とその中の時刻へ戻す
   */
  takes?: ReviewTake[]
  /** Agent へ最後に送った時刻（ISO8601）。追記した録画のうちまだ送っていない分を見分けるのに使う */
  sentAt?: string
  /** 何もない時間を削れなかった録画がある（元の動画のまま再生する）。画面に一度だけ控えめに知らせる */
  trimSkipped?: boolean
}

/** レビューに入っている録画1本（main/sessions/takes.ts） */
export interface ReviewTake {
  /** 1 が最初の録画。追記するたびに 2, 3 … */
  n: number
  /** レビューの時間軸での開始（ms）。指摘の t からこれを引くと、この録画の中の時刻になる */
  offsetMs: number
  durationMs: number
  /** 動画（既定7日で消える。消えたら無い） */
  videoUrl?: string
  /** このレビューに足した時刻（ISO8601）。最初の録画には無い */
  addedAt?: string
  /**
   * videoUrl が何もない時間を削った版なら、削った区間（この録画の中の時間）。
   * 再生位置は toTrimmedTime(cuts, t - offsetMs) で削った版の時間へ読み替える（shared/trim.ts）
   */
  cuts?: TrimCut[]
}

/** 時刻 t（レビューの時間軸）がどの録画のものか。録画の一覧が無ければ null */
export function takeAt(takes: ReviewTake[] | undefined, t: number): ReviewTake | null {
  if (!takes?.length) return null
  let found: ReviewTake | null = null
  for (const take of [...takes].sort((a, b) => a.offsetMs - b.offsetMs)) if (take.offsetMs <= t) found = take
  return found ?? takes[0] ?? null
}

/**
 * ▷ で開く動画と位置。t はレビューの時間軸の時刻。
 * 録画（take）の中の時刻へ戻し、削った版なら削った区間ぶん詰めた位置にする。label は元の録画の中の時刻（字幕に出す）
 */
export function playbackAt(takes: ReviewTake[] | undefined, videoUrl: string | undefined, t: number): { url: string; t: number; label: number; take: number | null } | null {
  const take = takeAt(takes, t)
  if (!take) return videoUrl ? { url: videoUrl, t, label: t, take: null } : null
  if (!take.videoUrl) return null
  const local = Math.max(0, t - take.offsetMs)
  return { url: take.videoUrl, t: toTrimmedTime(take.cuts, local), label: local, take: (takes?.length ?? 0) > 1 ? take.n : null }
}

/** まだ Agent へ送っていない追記の録画か（送ったあとに足したもの。一度も送っていなければ追記はすべて未送信） */
export function isUnsentTake(take: ReviewTake | null, sentAt: string | undefined): boolean {
  if (!take?.addedAt) return false
  return !sentAt || Date.parse(take.addedAt) > Date.parse(sentAt)
}

/** 進み具合の変更（指摘のID → 値）。todo で未対応に戻す */
export type ReviewProgressPatch = Record<string, ProgressPatchValue>
export type ReviewEdit =
  | { kind: 'undo' }
  | { kind: 'text'; id: string; title?: string; request?: string }
  | { kind: 'delete'; id: string }
  | { kind: 'include'; id: string; include: boolean }
  /** 整理が「要確認」にした指摘を確定する。手で要確認に戻す・次とまとめる操作は無くした（古い session.json の編集の列は main の ItemEdit で再生する） */
  | { kind: 'status'; id: string; status: 'decided' }
  | { kind: 'frames'; id: string; frameTimes: number[] }
  | { kind: 'note'; note: string }
  /** 指摘の並べ替え。ids は新しい並び（無い指摘はその位置のまま）。null で録画の時刻順に戻す */
  | { kind: 'order'; ids: string[] | null }

export interface ReviewFrame { t: number; image: string }
