import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '@shared/i18n/en'
import { ja } from '@shared/i18n/ja'
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  LOCALE_PREFERENCES,
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
  it('en と ja のキーが一致する（型でも検査しているが、実行時にも確かめる）', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort())
  })

  it('空の訳が無い', () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${locale}: ${key}`).not.toBe('')
      }
    }
  })

  it('ja の置き換えの変数（{{name}}）は en にあるものだけ（訳で省くのはよい。例: Hide {{app}} → 隠す）', () => {
    const vars = (s: string) => new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))
    const unknown = (Object.keys(en) as (keyof typeof en)[]).flatMap((key) => {
      const known = vars(en[key])
      return [...vars(ja[key])].filter((v) => !known.has(v)).map((v) => `${key}: {{${v}}}`)
    })
    expect(unknown).toEqual([])
  })

  it('数で形の変わるキーは _one と _other を対で持つ', () => {
    const keys = Object.keys(en)
    for (const key of keys.filter((k) => k.endsWith('_one'))) {
      expect(keys, key).toContain(key.replace(/_one$/, '_other'))
    }
  })

  it('言語の名前はその言語自身の表記で、選択肢は system と各言語', () => {
    expect(LOCALE_LABELS).toEqual({ en: 'English', ja: '日本語' })
    expect(LOCALE_PREFERENCES).toEqual(['system', 'en', 'ja'])
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
    expect(resolveLocale('system', ['fr-FR', 'ja-JP'])).toBe('ja')
    expect(resolveLocale('system', ['fr-FR', 'de-DE'])).toBe('en')
    expect(resolveLocale('system', [])).toBe('en')
    expect(resolveLocale(undefined, ['ja'])).toBe('ja')
  })

  it('明示した言語は OS の言語より優先する', () => {
    expect(resolveLocale('en', ['ja-JP'])).toBe('en')
    expect(resolveLocale('ja', ['en-US'])).toBe('ja')
  })

  it('言語タグを持っている辞書へ寄せる', () => {
    expect(normalizeSystemLocale('JA')).toBe('ja')
    expect(normalizeSystemLocale('zh-Hant')).toBe('en')
    expect(normalizeSystemLocale(undefined)).toBe('en')
  })
})

describe('設定の locale', () => {
  it('保存値は system / en / ja のどれかに直す。既定は system', () => {
    expect(sanitize({}).locale).toBe('system')
    expect(sanitize({ locale: 'ja' }).locale).toBe('ja')
    expect(sanitize({ locale: 'en' }).locale).toBe('en')
    expect(sanitize({ locale: 'fr' }).locale).toBe('system')
    expect(normalizeLocalePreference(1)).toBe('system')
  })

  it('画面の言語と文字起こしの言語は別の軸', () => {
    const s = sanitize({ locale: 'en', capture: { language: 'ja' } })
    expect(s.locale).toBe('en')
    expect(s.capture?.language).toBe('ja')
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
