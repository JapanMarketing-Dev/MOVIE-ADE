/**
 * 「新しいレビュー」をどのプロジェクトで始めるか（サイドバーのプロジェクトごとの ＋ と ⌘⇧R）。画面に依存しない純粋な関数。
 *
 *   - 開いているプロジェクトの ＋ / ⌘⇧R … そのまま始める
 *   - ほかのプロジェクトの ＋ … そのプロジェクトへ切り替えてから始める
 *   - 録画中 … 始めない（⌘⇧R は録画の停止なので、＋ からは止めずに知らせる）
 *   - プロジェクトが無い … 始められない（先にプロジェクトを足してもらう）
 */
type NewReviewPlan =
  | { action: 'start'; projectId: string }
  | { action: 'switch-then-start'; projectId: string }
  | { action: 'busy' }
  | { action: 'no-project' }

export function planNewReview(input: {
  /** ＋を押したプロジェクト。⌘⇧R など指定が無ければ開いているプロジェクト */
  projectId?: string | null
  activeProjectId: string | null
  /** 登録されているプロジェクトの id */
  projectIds: readonly string[]
  recording: boolean
}): NewReviewPlan {
  const target = input.projectId ?? input.activeProjectId
  if (!target || !input.projectIds.includes(target)) return { action: 'no-project' }
  if (input.recording) return { action: 'busy' }
  return target === input.activeProjectId ? { action: 'start', projectId: target } : { action: 'switch-then-start', projectId: target }
}
