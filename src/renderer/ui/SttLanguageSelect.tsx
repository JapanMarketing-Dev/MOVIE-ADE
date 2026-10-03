import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { STT_LANGUAGES, matchesSttLanguage, sttLanguageInfo, sttLanguageLabel, sttLanguageSupport, type SttLanguageCode } from '@shared/sttLanguages'
import { useT } from '../lib/i18n'

/**
 * 文字起こしの言語の選択。約100言語あるので、入力して絞り込めるコンボボックスにする。
 * 表示は「自称 (English)」、先頭は自動判定。キーボードは ↑↓ で移動、Enter で決定、Esc で閉じる。
 * provider を渡すと、その提供元が対応していない可能性のある言語のとき、下に小さく注記する（送信は止めない）。
 */
export function SttLanguageSelect({ value, onChange, disabled = false, ariaLabel, testId = 'stt-language-select', provider }: {
  value: SttLanguageCode
  onChange: (next: SttLanguageCode) => void
  disabled?: boolean
  ariaLabel: string
  testId?: string
  /** 選んでいる文字起こしの提供元（aiProviders.ts のプリセットの id と表示名。端末内は 'local'） */
  provider?: { id: string; label: string }
}) {
  const t = useT()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const autoLabel = t('settings.capture.languageAuto')
  const options = useMemo(() => {
    const langs = STT_LANGUAGES.filter((l) => matchesSttLanguage(l, query)).map((l) => ({ code: l.code, label: sttLanguageLabel(l) }))
    const showAuto = !query.trim() || autoLabel.toLowerCase().includes(query.trim().toLowerCase()) || 'auto'.includes(query.trim().toLowerCase())
    return showAuto ? [{ code: 'auto', label: autoLabel }, ...langs] : langs
  }, [query, autoLabel])

  const info = value === 'auto' ? undefined : sttLanguageInfo(value)
  const currentLabel = info ? sttLanguageLabel(info) : autoLabel

  // 外側を押したら閉じる
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (code: string) => {
    onChange(code)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setActive((i) => Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = options[active]
      if (open && pick) choose(pick.code)
      else setOpen(true)
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery('') }
    }
  }

  const unsupported = provider && info && sttLanguageSupport(provider.id, value) === 'unsupported'

  return (
    <div className="lang-combo" ref={rootRef}>
      <input
        className="st-select lang-combo__input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${options[active]!.code}` : undefined}
        data-testid={testId}
        disabled={disabled}
        spellCheck={false}
        placeholder={open ? t('stt.language.search') : undefined}
        value={open ? query : currentLabel}
        onFocus={() => { setOpen(true); setActive(0) }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true) }}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <ul className="lang-combo__list" role="listbox" id={listId} ref={listRef} aria-label={ariaLabel}>
          {options.length === 0 && <li className="lang-combo__empty">{t('stt.language.noMatch')}</li>}
          {options.map((o, i) => (
            <li key={o.code} id={`${listId}-${o.code}`} role="option" aria-selected={o.code === value} data-index={i}
              className={`lang-combo__option${i === active ? ' is-active' : ''}${o.code === value ? ' is-selected' : ''}`}
              onPointerEnter={() => setActive(i)}
              onPointerDown={(e) => { e.preventDefault(); choose(o.code) }}>
              <span>{o.label}</span>
              {o.code !== 'auto' && <span className="lang-combo__code">{o.code}</span>}
            </li>
          ))}
        </ul>
      )}
      {unsupported && <p className="st-note st-note--warn lang-combo__note" data-testid={`${testId}-unsupported`}>
        {t('stt.language.unsupported', { provider: provider!.label, language: info!.english })}</p>}
    </div>
  )
}
