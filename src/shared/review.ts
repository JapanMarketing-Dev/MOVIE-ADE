import type { FeedbackDocument } from '../main/pipeline/types'

export interface ReviewSummary {
  id: string
  startedAt: string
  durationMs: number
  itemCount: number
  targetUrl?: string
  incomplete: boolean
  /** 記録が壊れていて開けない */
  broken?: boolean
  /** 利用者が付けた名前（一覧の見出しに使う） */
  name?: string
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
}
export type ReviewEdit =
  | { kind: 'undo' }
  | { kind: 'text'; id: string; title?: string; request?: string }
  | { kind: 'delete'; id: string }
  | { kind: 'merge'; ids: string[] }
  | { kind: 'include'; id: string; include: boolean }
  | { kind: 'status'; id: string; status: 'decided' | 'needs_check' }
  | { kind: 'frames'; id: string; frameTimes: number[] }
  | { kind: 'note'; note: string }

export interface ReviewFrame { t: number; image: string }
