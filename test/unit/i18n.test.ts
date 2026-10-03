import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '@shared/i18n/en'
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  LOCALE_PREFERENCES,
  PRODUCT_NAME,
  getLocale,
  interpolate,
  normalizeLocalePreference,
  normalizeSystemLocale,
  onLocaleChange,
  resolveLocale,
  setLocale,
  t,
  translate
} from '@shared/i18n'
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback'
import { material } from './fixtures'
import { buildDraftDocument } from '../../src/main/pipeline'

// settings.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))
const { sanitize } = await import('../../src/main/settings')

afterEach(() => setLocale('en'))

describe('辞書', () => {
  // 言語ごとの辞書が en と同じキーを持つ。欠けは実行時に英語で出るが、出荷前にここで止める
  const enKeys = Object.keys(en).sort()
  const vars = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))].sort()
  // 訳で省いてよい変数（日本語の macOS の慣習で、メニューにアプリ名を出さない）
  const OPTIONAL_VARS: Record<string, string[]> = { 'menu.hide': ['app'], 'menu.quit': ['app'] }

  it.each(Object.keys(LOCALES).filter((l) => l !== 'en'))('%s: en と同じキーを持つ（欠けも余分も無い）', (locale) => {
    const keys = Object.keys(LOCALES[locale as keyof typeof LOCALES])
    expect({ missing: enKeys.filter((k) => !keys.includes(k)), extra: keys.filter((k) => !(k in en)) }).toEqual({ missing: [], extra: [] })
  })

  it.each(Object.keys(LOCALES).filter((l) => l !== 'en'))('%s: {{変数}} が en と一致する', (locale) => {
    const dict = LOCALES[locale as keyof typeof LOCALES] as Record<string, string>
    const bad = enKeys.flatMap((key) => {
      const value = dict[key]
      if (value === undefined) return []
      const need = vars((en as Record<string, string>)[key]!)
      const have = vars(value)
      const optional = OPTIONAL_VARS[key] ?? []
      const ok = have.every((v) => need.includes(v)) && need.every((v) => have.includes(v) || optional.includes(v))
      return ok ? [] : [`${key}: en=${need.join(',')} ${locale}=${have.join(',')}`]
    })
    expect(bad).toEqual([])
  })

  it('空の訳が無い', () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${locale}: ${key}`).not.toBe('')
      }
    }
  })

  it('数で形の変わるキーは _one に対して _other か元のキー（count 以外のときに引く文）を持つ', () => {
    const keys = Object.keys(en)
    const lonely = keys.filter((k) => k.endsWith('_one') && !keys.includes(k.replace(/_one$/, '_other')) && !keys.includes(k.replace(/_one$/, '')))
    expect(lonely).toEqual([])
  })

  it('言語の名前はその言語自身の表記で、選択肢は system と14言語', () => {
    expect(LOCALE_LABELS).toEqual({
      en: 'English', ja: '日本語', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ko: '한국어', es: 'Español', fr: 'Français',
      de: 'Deutsch', 'pt-BR': 'Português (Brasil)', it: 'Italiano', ru: 'Русский', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', hi: 'हिन्दी'
    })
    expect(LOCALE_PREFERENCES).toEqual(['system', ...Object.keys(LOCALE_LABELS)])
  })

  it('製品名とコードの識別子は訳さない', () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const d = dict as Record<string, string>
      if (d['github.issue.sentFrom']) expect(d['github.issue.sentFrom'], locale).toContain(PRODUCT_NAME)
      if (d['agentPrompt.default']) expect(d['agentPrompt.default'], locale).toContain('"{{path}}"')
    }
  })
})

describe('t() と置き換え', () => {
  it('既定は英語', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(getLocale()).toBe('en')
    expect(t('menu.newTerminal')).toBe('New Terminal')
  })

  it('言語を切り替えると同じキーで別の文になり、購読者に知らせる', () => {
    const seen: string[] = []
    const off = onLocaleChange((l) => seen.push(l))
    setLocale('ja')
    expect(t('menu.file')).toBe('ファイル')
    setLocale('ja') // 同じ言語なら知らせない
    off()
    setLocale('en')
    expect(seen).toEqual(['ja'])
  })

  it('{{name}} を置き換える。数も文字にする。足りない変数はそのまま残す', () => {
    expect(interpolate('Hide {{app}}', { app: 'ADE' })).toBe('Hide ADE')
    expect(interpolate('{{ n }} / {{n}}', { n: 3 })).toBe('3 / 3')
    expect(interpolate('Hi {{who}}', {})).toBe('Hi {{who}}')
    expect(interpolate('Hi {{who}}', { who: null })).toBe('Hi {{who}}')
    expect(translate('en', 'menu.about', { app: 'ADE' })).toBe('About ADE')
    expect(translate('ja', 'menu.about', { app: 'ADE' })).toBe('ADE について')
  })

  it('count で単数・複数を選ぶ（日本語は形が変わらない）', () => {
    expect(translate('en', 'feedbackMd.title', { count: 1 })).toBe('UI Feedback (1 item)')
    expect(translate('en', 'feedbackMd.title', { count: 3 })).toBe('UI Feedback (3 items)')
    expect(translate('en', 'feedbackMd.title', { count: 0 })).toBe('UI Feedback (0 items)')
    expect(translate('ja', 'feedbackMd.title', { count: 1 })).toBe('UIフィードバック（1件）')
  })

  it('辞書に無いキーは英語へ、英語にも無ければキーを返す', () => {
    const missing = 'nope.missing' as Parameters<typeof t>[0]
    expect(translate('ja', missing)).toBe('nope.missing')
    // 部分的な辞書（今後足す言語）でも、欠けたキーは英語で出る
    const original = (LOCALES as Record<string, unknown>).ja
    ;(LOCALES as Record<string, unknown>).ja = { 'menu.file': 'ファイル' }
    try {
      expect(translate('ja', 'menu.file')).toBe('ファイル')
      expect(translate('ja', 'menu.edit')).toBe('Edit')
    } finally {
      ;(LOCALES as Record<string, unknown>).ja = original
    }
  })
})

describe('システムに合わせる', () => {
  it('OS の先頭の言語が対応していればそれを使う', () => {
    expect(resolveLocale('system', ['ja-JP', 'en-US'])).toBe('ja')
    expect(resolveLocale('system', ['en-GB', 'ja-JP'])).toBe('en')
    expect(resolveLocale('system', 'ja_JP')).toBe('ja')
  })

  it('先頭が未対応なら、優先順の次の対応言語を使う。どれも無ければ英語', () => {
    expect(resolveLocale('system', ['sw-KE', 'ja-JP'])).toBe('ja')
    expect(resolveLocale('system', ['sw-KE', 'am-ET'])).toBe('en')
    expect(resolveLocale('system', [])).toBe('en')
    expect(resolveLocale(undefined, ['ja'])).toBe('ja')
  })

  it('明示した言語は OS の言語より優先する', () => {
    expect(resolveLocale('en', ['ja-JP'])).toBe('en')
    expect(resolveLocale('ja', ['en-US'])).toBe('ja')
  })

  it('言語タグを持っている辞書へ寄せる', () => {
    expect(normalizeSystemLocale('JA')).toBe('ja')
    expect(normalizeSystemLocale(undefined)).toBe('en')
    expect(normalizeSystemLocale('sw-KE')).toBe('en')
  })

  it('地域・文字体系つきのタグは最も近い言語へ寄せる', () => {
    expect(normalizeSystemLocale('zh-Hant')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-HK')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeSystemLocale('zh')).toBe('zh-CN')
    expect(normalizeSystemLocale('zh_SG')).toBe('zh-CN')
    expect(normalizeSystemLocale('pt-PT')).toBe('pt-BR')
    expect(normalizeSystemLocale('pt')).toBe('pt-BR')
    expect(normalizeSystemLocale('de-AT')).toBe('de')
    expect(normalizeSystemLocale('es-419')).toBe('es')
    expect(normalizeSystemLocale('in-ID')).toBe('id')
    expect(normalizeSystemLocale('hi-IN')).toBe('hi')
    expect(resolveLocale('system', ['sw-KE', 'ko-KR'])).toBe('ko')
  })
})

describe('設定の locale', () => {
  it('保存値は system か対応する言語。未設定は system、知らない値は en に直す', () => {
    expect(sanitize({}).locale).toBe('system')
    expect(sanitize({ locale: 'ja' }).locale).toBe('ja')
    expect(sanitize({ locale: 'zh-TW' }).locale).toBe('zh-TW')
    expect(sanitize({ locale: 'pt-BR' }).locale).toBe('pt-BR')
    expect(sanitize({ locale: 'system' }).locale).toBe('system')
    expect(sanitize({ locale: 'xx' }).locale).toBe('en')
    expect(sanitize({ locale: 'zh' }).locale).toBe('en')
    expect(normalizeLocalePreference(1)).toBe('en')
    expect(normalizeLocalePreference(undefined)).toBe('system')
  })

  it('画面の言語と文字起こしの言語は別の軸', () => {
    const s = sanitize({ locale: 'en', capture: { language: 'ja' } })
    expect(s.locale).toBe('en')
    expect(s.capture?.language).toBe('ja')
  })
})

describe('新しい言語の t()', () => {
  it('各言語の文を引き、欠けたキーは英語で出す', () => {
    expect(translate('de', 'menu.file')).not.toBe('File')
    expect(translate('zh-CN', 'feedbackMd.title', { count: 3 })).toContain('3')
    expect(translate('ru', 'menu.about', { app: PRODUCT_NAME })).toContain(PRODUCT_NAME)
    const original = (LOCALES as Record<string, unknown>).ko
    ;(LOCALES as Record<string, unknown>).ko = {}
    try {
      expect(translate('ko', 'menu.file')).toBe('File')
    } finally {
      ;(LOCALES as Record<string, unknown>).ko = original
    }
  })
})

describe('Agent に渡す feedback.md', () => {
  it('画面の言語で書き出す。発話の原文は訳さない', () => {
    const { document } = buildDraftDocument(material)
    const enMd = renderFeedbackMarkdown(document)
    expect(enMd).toMatch(/^# UI Feedback \(\d+ items?\)/)
    expect(enMd).toContain('- Speech (verbatim): ')
    setLocale('ja')
    const jaMd = renderFeedbackMarkdown(document)
    expect(jaMd).toMatch(/^# UIフィードバック（\d+件）/)
    expect(jaMd).toContain('- 発話（原文）: ')
    // 明示した言語は今の言語より優先する
    expect(renderFeedbackMarkdown(document, { locale: 'en' })).toBe(enMd)
  })
})
