import { useEffect, useRef } from 'react'
import type { ProjectSession } from '@shared/types'
import { decodeCenterTab, encodeCenterTab } from '@shared/projectSession'

/**
 * プロジェクトごとの作業の状態（中央のタブ・開いていたファイル・表示中のレビュー）を覚えて戻す。
 * 内蔵ブラウザの URL は main が覚えて戻すので、ここでは扱わない（src/main/index.ts の openProject）。
 *
 *   - 切り替えた直後（と起動直後）に、そのプロジェクトで前に開いていたファイルを開き直し、タブの選択とレビューを戻す
 *   - その後の変更は少し待ってまとめて main へ送る（設定に保存され、再起動しても戻る）
 * 戻し終える前の変更は送らない。切り替え直後の1回目の描画は、まだ前のプロジェクトのタブを持っているため。
 *
 * 設定のページ（'settings'）はプロジェクトに属さないので、覚えもせず、開いていればそのまま残す。
 */
const SAVE_DELAY_MS = 400

export function useProjectSession({
  projectId,
  root,
  ready,
  centerTab,
  setCenterTab,
  openPaths,
  openFile,
  reviewId,
  onRestoreReview
}: {
  projectId: string | null
  /** 開いているプロジェクトのフォルダ（ファイルのタブの根） */
  root: string | null
  /** 設定とワークスペースを読み終えたか */
  ready: boolean
  centerTab: string
  setCenterTab: (tab: string) => void
  /** 今のプロジェクトで開いているファイル（相対パス、開いた順） */
  openPaths: string[]
  openFile: (path: string) => void
  /** 表示中のレビュー */
  reviewId: string | null
  onRestoreReview: (reviewId: string | null) => void
}): void {
  const restoredFor = useRef<string | null | undefined>(undefined)
  // 戻すのは非同期の後なので、最新の関数を ref で持つ（その時点の根で開く）
  const latest = useRef({ openFile, setCenterTab, onRestoreReview, centerTab })
  latest.current = { openFile, setCenterTab, onRestoreReview, centerTab }

  useEffect(() => {
    if (!ready) return
    if (!projectId) { restoredFor.current = null; return }
    let cancelled = false
    // 状態の保存は通知を出さないので、手元の一覧ではなく main から最新を読む
    void window.ade.invoke('project:list').then((state) => {
      if (cancelled) return
      const session: ProjectSession = state.projects.find((p) => p.id === projectId)?.session ?? {}
      const { openFile: open, setCenterTab: setTab, onRestoreReview: restoreReview, centerTab: current } = latest.current
      for (const path of session.openFiles ?? []) open(path)
      if (current !== 'settings') setTab(decodeCenterTab(session.centerTab, root) ?? 'browser')
      restoreReview(session.reviewId ?? null)
      restoredFor.current = projectId
    }).catch(() => { if (!cancelled) restoredFor.current = projectId }) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    return () => { cancelled = true }
  }, [projectId, root, ready])

  const pathsKey = openPaths.join('\n')
  useEffect(() => {
    if (!projectId || restoredFor.current !== projectId) return
    const session: Pick<ProjectSession, 'centerTab' | 'openFiles'> & { reviewId: string | null } = {
      openFiles: pathsKey ? pathsKey.split('\n') : [],
      reviewId
    }
    const tab = centerTab === 'settings' ? undefined : encodeCenterTab(centerTab, root)
    if (tab) session.centerTab = tab
    let sent = false
    const send = () => {
      if (sent) return
      sent = true
      void window.ade.invoke('project:saveSession', projectId, session).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    }
    const timer = window.setTimeout(send, SAVE_DELAY_MS)
    // 待っている間に切り替えても、前のプロジェクトの最後の状態を取りこぼさない
    return () => { window.clearTimeout(timer); send() }
  }, [projectId, root, centerTab, pathsKey, reviewId])
}
