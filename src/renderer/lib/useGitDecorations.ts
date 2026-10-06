import { useEffect, useMemo, useState } from 'react'
import { buildGitDecorations, type FsGitStatus, type GitDecorations } from '@shared/gitDecorations'

/**
 * ファイルツリーの git の色分けの状態（fs:gitStatus）。
 *
 * 読み直すのは、ファイルの変更（fs:changed。保存・Agent の書き換え）、.git の HEAD・index の変化（github:headChanged。コミット・ステージ）、
 * ウインドウを前に出したとき。続けて起きたものはまとめ、git を重ねて走らせない（走っている間の変化は、終わってから1回だけ読み直す）。
 * null は「まだ分からない」（.env などを念のため隠す。@shared/gitDecorations の isHiddenByDefault）。
 */

/** 変更の通知から git を呼ぶまでの待ち（Agent が続けて書くときに1回へまとめる） */
const GIT_REFRESH_DEBOUNCE_MS = 600

export function useGitDecorations(root: string | null): GitDecorations | null {
  const [status, setStatus] = useState<FsGitStatus | null>(null)

  useEffect(() => {
    setStatus(null)
    if (!root) return
    let disposed = false
    let running = false
    let again = false
    let timer: number | undefined
    const load = async () => {
      if (running) { again = true; return }
      running = true
      try {
        const next = await window.ade.invoke('fs:gitStatus')
        if (!disposed) setStatus(next)
      } catch {
        // プロジェクトを閉じた・切り替えた直後など（想定内）。色を付けないだけ
        if (!disposed) setStatus({ isGit: false, entries: [], truncated: false })
      } finally {
        running = false
        if (again && !disposed) { again = false; schedule() }
      }
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), GIT_REFRESH_DEBOUNCE_MS)
    }
    void load()
    const offFs = window.ade.on('fs:changed', schedule)
    const offHead = window.ade.on('github:headChanged', schedule)
    window.addEventListener('focus', schedule)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      offFs()
      offHead()
      window.removeEventListener('focus', schedule)
    }
  }, [root])

  return useMemo(() => (status ? buildGitDecorations(status) : null), [status])
}
