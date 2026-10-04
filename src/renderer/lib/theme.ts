import { useSyncExternalStore } from 'react'
import type { ThemePreference } from '@shared/types'
import { normalizeThemePreference, type ResolvedTheme } from '@shared/theme'

/**
 * 配色（ライト／ダーク／システム）。
 *
 * 解決は main が持つ（nativeTheme.themeSource を設定に合わせ、shouldUseDarkColors を読む）。
 * renderer は届いた「解決済みの配色」を <html data-theme> に書くだけにする
 * （docs/04_benchmark.md 2.1。CSS はメディアクエリを使わない）。
 * prefers-color-scheme を読まないのは、Playwright が既定でライトに上書きするため。
 *   起動時 … window.ade.initialTheme（main が additionalArguments で渡す）
 *   変更時 … 'theme:changed' イベント
 *
 * 配色が変わると window に 'ade:themechange'（detail: { theme: ResolvedTheme }）を投げる。
 * xterm や Monaco のように CSS 変数を JS で読み込む部品は、これを聞いて自分のテーマを作り直す。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/lib/document-theme.ts（MIT）
 *   切り替えの瞬間に .theme-transition-disabled を付け、2フレーム後に外す方式。
 */

export const THEME_CHANGE_EVENT = 'ade:themechange'
export interface ThemeChangeDetail {
  theme: ResolvedTheme
}

const TRANSITION_DISABLED_CLASS = 'theme-transition-disabled'

let preference: ThemePreference = 'system'
const listeners = new Set<() => void>()
let pendingFrames: number[] = []

/** いま画面に出ている配色 */
export function currentTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  if (root.dataset.theme === theme) return

  root.classList.add(TRANSITION_DISABLED_CLASS)
  root.dataset.theme = theme
  window.dispatchEvent(
    new CustomEvent<ThemeChangeDetail>(THEME_CHANGE_EVENT, { detail: { theme } })
  )

  // 2フレーム待ってから戻す。変数の再計算が終わる前に戻すと、部品ごとにばらばらにフェードする
  for (const id of pendingFrames) cancelAnimationFrame(id)
  pendingFrames = []
  const first = requestAnimationFrame(() => {
    const second = requestAnimationFrame(() => {
      root.classList.remove(TRANSITION_DISABLED_CLASS)
      pendingFrames = []
    })
    pendingFrames.push(second)
  })
  pendingFrames.push(first)
}

/** 起動時に1度だけ呼ぶ（描画の前）。保存済みの設定は後から届く */
export function initTheme(): void {
  applyTheme(window.ade.initialTheme)
  // 設定の変更と、system のときの OS 側の切り替えの両方でここに来る
  window.ade.on('theme:changed', applyTheme)
  // settings.json の外部の変更。配色そのものは main が themeSource を変えて 'theme:changed' で届く
  window.ade.on('settings:changed', (settings) => {
    preference = normalizeThemePreference(settings.theme)
    emit()
  })
  void window.ade
    .invoke('app:settings')
    .then((settings) => {
      preference = normalizeThemePreference(settings.theme)
      emit()
    })
    .catch(() => {
      // 設定が読めなくても、OS に追従した配色のまま使える
    })
}

function emit(): void {
  for (const listener of listeners) listener()
}

function setThemePreference(next: ThemePreference): void {
  preference = next
  emit()
  // ライト／ダークは即座に反映する。system は main が themeSource を戻したあと、
  // 'theme:changed' で OS の配色に落ち着く
  if (next !== 'system') applyTheme(next)
  void window.ade.invoke('settings:theme', next)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 設定画面・フッターの切り替えUIから使う */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const value = useSyncExternalStore(subscribe, () => preference)
  return [value, setThemePreference]
}
