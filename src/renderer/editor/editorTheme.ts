import { useEffect, useState } from 'react'
import type { ResolvedTheme } from '@shared/theme'
import { THEME_CHANGE_EVENT, currentTheme, type ThemeChangeDetail } from '../lib/theme'
import type { monaco as Monaco } from './monacoSetup'

/**
 * アプリの配色（ライト／ダーク）に Monaco を追従させる。
 * design-system との取り決め: 解決済みの配色は currentTheme()（<html data-theme>）、
 * 変わると window に 'ade:themechange' が飛ぶ（src/renderer/lib/theme.ts）。
 * tokens.css の面の色を読み、エディタの地をペインの地（--color-bg-panel）と揃える。
 */
type AppTheme = ResolvedTheme

export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(currentTheme)
  useEffect(() => {
    const onChange = (event: Event) => setTheme((event as CustomEvent<ThemeChangeDetail>).detail.theme)
    window.addEventListener(THEME_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange)
  }, [])
  return theme
}

/** Monaco は #rrggbb(aa) しか受け付けない。読めない値は使わない */
function token(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined
}

/** テーマを（今のトークンの値で）定義し直して名前を返す */
export function applyEditorTheme(monaco: typeof Monaco, theme: AppTheme): string {
  const name = theme === 'light' ? 'ade-light' : 'ade-dark'
  const colors: Record<string, string> = {}
  // 読めなければ tokens.css の --color-bg-panel と同じ値（design-system との取り決め）
  const background = token('--color-bg-panel') ?? (theme === 'light' ? '#ffffff' : '#171717')
  colors['editor.background'] = background
  colors['editorGutter.background'] = background
  colors['minimap.background'] = background
  const selected = token('--color-surface-selected')
  if (selected) colors['editor.lineHighlightBackground'] = selected
  monaco.editor.defineTheme(name, { base: theme === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: [], colors })
  monaco.editor.setTheme(name)
  return name
}
