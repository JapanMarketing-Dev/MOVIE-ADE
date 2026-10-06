import { useSyncExternalStore } from 'react'
import { DEFAULT_LAYOUT, sanitizeLayout, togglePanel, type ClosablePanel, type LayoutPrefs } from '@shared/layout'

/**
 * 画面の配置（パネルの置き場所・表示、フッターの項目）。
 * App（実際に並べる側）と設定ダイアログの「レイアウト」欄・メニュー（⌘B / ⌘J など）が同じ値を見るため、
 * lib/theme.ts と同じく小さな外部ストアにする。変更はその場で反映し、main の設定へ保存する。
 */

let current: LayoutPrefs = DEFAULT_LAYOUT
let loaded = false
/*
 * ブラウザに集中する（タイトルバーのボタン）。ブラウザ以外のパネルを隠して見せる（@shared/layout の browserFocusLayout）。
 * 設定の配置は変えず、保存もしない（起動し直すと元の配置）。もう一度押すと元の配置に戻る
 */
let browserFocus = false

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

/** 配置を変える。関数を渡すと今の値から作る（連打しても古い値から作らない）。パネルの開閉・置き場所が変われば、ブラウザへの集中もやめる */
export function setLayout(next: LayoutPrefs | ((prev: LayoutPrefs) => LayoutPrefs)): void {
  const prev = current
  current = sanitizeLayout(typeof next === 'function' ? next(current) : next)
  if (JSON.stringify(prev.panels) !== JSON.stringify(current.panels)) browserFocus = false
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

export function setBrowserFocus(on: boolean): void {
  if (browserFocus === on) return
  browserFocus = on
  emit()
}

/** 「Agentへ送信」でターミナルを見せたいときなど、集中をやめて元の配置に戻す */
export function exitBrowserFocus(): void {
  setBrowserFocus(false)
}

/**
 * タイトルバーの開閉ボタン・⌘⇧E。集中している間は、見た目では閉じているので、集中をやめてそのパネルを開く
 * （ほかのパネルも元の配置に戻る）。ふだんは開閉を切り替える
 */
export function togglePanelShown(id: ClosablePanel): void {
  if (browserFocus) {
    browserFocus = false
    setLayout((prev) => togglePanel(prev, id, true))
    emit()
    return
  }
  setLayout((prev) => togglePanel(prev, id))
}

function currentFocus(): boolean {
  return browserFocus
}

export function useBrowserFocus(): boolean {
  return useSyncExternalStore(subscribe, currentFocus)
}
