import type { ThemePreference } from './types'

/**
 * 配色の解決。main（nativeTheme・ウインドウの背景）と renderer（data-theme）の両方が使う。
 * Orca由来: ~/bench/orca/src/renderer/src/lib/document-theme.ts の resolveDocumentTheme（MIT）
 */

export type ResolvedTheme = 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** ウインドウと内蔵ブラウザの背景。tokens.css の --color-bg-app と同じ値にする */
export const THEME_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#0a0a0a',
  light: '#ffffff'
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'dark') return 'dark'
  if (preference === 'light') return 'light'
  return systemPrefersDark ? 'dark' : 'light'
}
