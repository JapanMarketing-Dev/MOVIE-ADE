import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemePreference } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import { useThemePreference } from '../lib/theme'
import { useT } from '../lib/i18n'
import { IconButton } from './Button'
import { Segmented, type SegmentedOption } from './Segmented'

/**
 * 配色の切り替え。
 *   ThemeSegmented … 設定ダイアログ用。3択を並べる
 *   ThemeToggle    … フッター用。押すたびに システム → ライト → ダーク と巡る
 * どちらも lib/theme.ts の同じ状態を読むので、片方で変えるともう片方も追従する。
 */

const LABEL: Record<ThemePreference, MessageKey> = {
  system: 'theme.system',
  light: 'theme.light',
  dark: 'theme.dark'
}

const ICON: Record<ThemePreference, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon
}

const ORDER: ThemePreference[] = ['system', 'light', 'dark']

export function ThemeSegmented({ className }: { className?: string }) {
  const t = useT()
  const [theme, setTheme] = useThemePreference()
  const options: ReadonlyArray<SegmentedOption<ThemePreference>> = ORDER.map((value) => {
    const Icon = ICON[value]
    return { value, label: t(LABEL[value]), icon: <Icon size={14} />, testId: `theme-${value}` }
  })
  return (
    <Segmented
      options={options}
      value={theme}
      onChange={setTheme}
      ariaLabel={t('theme.label')}
      className={className}
    />
  )
}

export function ThemeToggle({ className }: { className?: string }) {
  const t = useT()
  const [theme, setTheme] = useThemePreference()
  const Icon = ICON[theme]
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!
  return (
    <IconButton
      size="sm"
      className={className}
      label={t('theme.toggleLabel', { current: t(LABEL[theme]), next: t(LABEL[next]) })}
      title={t('theme.toggleTitle', { current: t(LABEL[theme]) })}
      icon={<Icon size={14} />}
      data-testid="theme-toggle"
      onClick={() => setTheme(next)}
    />
  )
}
