import { useEffect, useRef, useState } from 'react'
import { pushRecentUrl, sanitizeUrlHistory } from '@shared/reviewTarget'
import { readLocal, writeLocal } from './localPref'

/**
 * 内蔵ブラウザで開いた URL の履歴（プロジェクトごと、新しい順）。
 * フィードバックの右パネルの URL ツリー（確認先の下のページ）の元になる。
 * パネルを閉じていても、エディタモードでも積むので、App で動かす。この端末だけに覚える。
 */

/** 覚えておく件数の上限。URL ツリーはこの中からパスの木を作る */
const URL_HISTORY_MAX = 200

/** 以前「最近の URL」として 8 件だけ覚えていた鍵をそのまま使い、上限だけ広げる */
function urlHistoryKey(projectId: string): string {
  return `ade.feedback.recent.${projectId}`
}

/** 壊れた値・古い形の値は空として読む（sanitizeUrlHistory） */
function load(key: string): string[] {
  return sanitizeUrlHistory(readLocal(key), URL_HISTORY_MAX)
}

export function useUrlHistory(projectId: string | null, currentUrl: string): string[] {
  const key = urlHistoryKey(projectId ?? 'none')
  const [history, setHistory] = useState<string[]>(() => load(key))
  /** いまの鍵で最後に見た URL。プロジェクトを切り替えた直後は前のプロジェクトの URL がまだ出ているので、鍵が変わった時点の URL は積まない */
  const seen = useRef<{ key: string; url: string } | null>(null)
  useEffect(() => setHistory(load(key)), [key])
  useEffect(() => {
    const previous = seen.current
    seen.current = { key, url: currentUrl }
    if (previous && previous.key !== key) return
    // プロジェクトを開いていなくても覚える（'none' の鍵）。右パネルの「最近開いた URL」に出す
    if (!currentUrl || currentUrl === 'about:blank') return
    setHistory((prev) => {
      const next = pushRecentUrl(prev, currentUrl, URL_HISTORY_MAX)
      writeLocal(key, JSON.stringify(next))
      return next
    })
  }, [projectId, currentUrl, key])
  return history
}
