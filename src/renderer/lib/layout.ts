import { useSyncExternalStore } from 'react'
import { DEFAULT_LAYOUT, sanitizeLayout, type LayoutPrefs } from '@shared/layout'

/**
 * 画面の配置（パネルの置き場所・表示、フッターの項目）。
 * App（実際に並べる側）と設定ダイアログの「レイアウト」欄・メニュー（⌘B / ⌘J など）が同じ値を見るため、
 * lib/theme.ts と同じく小さな外部ストアにする。変更はその場で反映し、main の設定へ保存する。
 */

let current: LayoutPrefs = DEFAULT_LAYOUT
let loaded = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 起動時に保存済みの配置を読む。読めなければ既定のまま */
export function initLayout(): void {
  if (loaded) return
  loaded = true
  void window.ade
    .invoke('app:settings')
    .then((settings) => {
      current = sanitizeLayout(settings.layout, settings.terminalDock)
      emit()
    })
    .catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  // settings.json の外部の変更（Claude Code などが書き換えた）。保存し直さずに反映だけする
  window.ade.on('settings:changed', (settings) => {
    current = sanitizeLayout(settings.layout)
    emit()
  })
}

function currentLayout(): LayoutPrefs {
  return current
}

/** 配置を変える。関数を渡すと今の値から作る（連打しても古い値から作らない） */
export function setLayout(next: LayoutPrefs | ((prev: LayoutPrefs) => LayoutPrefs)): void {
  current = sanitizeLayout(typeof next === 'function' ? next(current) : next)
  emit()
  void window.ade.invoke('settings:layout', current).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLayout(): LayoutPrefs {
  return useSyncExternalStore(subscribe, currentLayout)
}
