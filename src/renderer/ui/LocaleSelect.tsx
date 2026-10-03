import { LOCALE_LABELS, LOCALE_PREFERENCES, type LocalePreference } from '@shared/i18n'
import { useLocalePreference, useT } from '../lib/i18n'

/**
 * 画面の言語の選択（設定・オンボーディングで共用）。
 * 言語は14あり、ボタンを並べると収まらないので select にする。
 * 各言語はその言語自身の表記で出す（どの言語の画面でも同じ並び・同じ名前）。
 */
export function LocaleSelect({ ariaLabel, testId = 'locale-select', className = 'st-select' }: { ariaLabel: string; testId?: string; className?: string }) {
  const t = useT()
  const [locale, setLocale] = useLocalePreference()
  return (
    <select className={className} aria-label={ariaLabel} data-testid={testId} value={locale}
      onChange={(e) => setLocale(e.target.value as LocalePreference)}>
      {LOCALE_PREFERENCES.map((value) => (
        <option key={value} value={value} lang={value === 'system' ? undefined : value}>
          {value === 'system' ? t('settings.language.system') : LOCALE_LABELS[value]}
        </option>
      ))}
    </select>
  )
}
