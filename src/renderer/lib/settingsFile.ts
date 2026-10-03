import { useSyncExternalStore } from 'react'

/**
 * settings.json の外部の変更（利用者のエディタ・Claude Code など）を取り込んだ回数。
 * 自分で設定を読み込む節（文字起こし・整理・GitHub など）は、これを key や依存配列に入れて読み直す。
 */
let revision = 0
let subscribed = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  if (!subscribed) {
    subscribed = true
    window.ade.on('settings:changed', () => {
      revision += 1
      for (const l of listeners) l()
    })
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettingsRevision(): number {
  return useSyncExternalStore(subscribe, () => revision)
}
