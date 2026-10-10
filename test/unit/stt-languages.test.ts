import { describe, expect, it, vi } from 'vitest'
import {
  STT_LANGUAGES,
  STT_LANGUAGE_CODES,
  matchesSttLanguage,
  normalizeSttLanguage,
  sttLanguageInfo,
  sttLanguageLabel,
  sttLanguageSupport,
  toWhisperLanguage
} from '@shared/sttLanguages'

// settings.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))
const { sanitize } = await import('../../src/main/settings')

describe('文字起こしの言語の一覧', () => {
  it('whisper の対応言語（99言語 + 広東語）。コードは重複しない', () => {
    expect(STT_LANGUAGES).toHaveLength(100)
    expect(new Set(STT_LANGUAGE_CODES).size).toBe(100)
    for (const code of ['ja', 'en', 'zh', 'ko', 'de', 'hi', 'vi', 'id', 'pt', 'ru', 'haw', 'yue', 'jv']) expect(STT_LANGUAGE_CODES).toContain(code)
    expect(STT_LANGUAGE_CODES).not.toContain('jw')
  })

  it('コードは ISO 639-1（639-1 を持たない haw / yue だけ 3文字）', () => {
    for (const code of STT_LANGUAGE_CODES) expect(code, code).toMatch(code === 'haw' || code === 'yue' ? /^[a-z]{3}$/ : /^[a-z]{2}$/)
  })

  it('表示は「自称 (English)」。同じなら1つ', () => {
    expect(sttLanguageLabel(sttLanguageInfo('ja')!)).toBe('日本語 (Japanese)')
    expect(sttLanguageLabel(sttLanguageInfo('en')!)).toBe('English')
  })

  it('検索はコード・英語名・自称のどれでも、大文字小文字とアクセントを無視して当たる', () => {
    const find = (q: string) => STT_LANGUAGES.filter((l) => matchesSttLanguage(l, q)).map((l) => l.code)
    expect(find('japan')).toEqual(['ja'])
    expect(find('日本')).toEqual(['ja'])
    expect(find('DE')).toContain('de')
    expect(find('espanol')).toContain('es')
    expect(find('tieng viet')).toContain('vi')
    expect(find('')).toHaveLength(100)
  })
})

describe('保存値の検査', () => {
  it('auto か一覧のコード。地域つき・大文字・whisper の別名は寄せ、知らない値は auto', () => {
    expect(normalizeSttLanguage('ja')).toBe('ja')
    expect(normalizeSttLanguage('PT-BR')).toBe('pt')
    expect(normalizeSttLanguage('zh_TW')).toBe('zh')
    expect(normalizeSttLanguage('jw')).toBe('jv')
    expect(normalizeSttLanguage('xx')).toBe('auto')
    expect(normalizeSttLanguage('')).toBe('auto')
    expect(normalizeSttLanguage(3)).toBe('auto')
  })

  it('設定の capture.language も同じ規則で直す（画面の言語とは別）', () => {
    expect(sanitize({ capture: { language: 'de' } }).capture?.language).toBe('de')
    expect(sanitize({ capture: { language: 'klingon' } }).capture?.language).toBe('auto')
    expect(sanitize({ locale: 'en', capture: { language: 'ja' } })).toMatchObject({ locale: 'en', capture: { language: 'ja' } })
  })

  it('whisper.cpp へ渡すときだけ Javanese を jw にする', () => {
    expect(toWhisperLanguage('jv')).toBe('jw')
    expect(toWhisperLanguage('ja')).toBe('ja')
    expect(toWhisperLanguage('auto')).toBe('auto')
  })
})

describe('提供元ごとの対応', () => {
  it('whisper 系・ElevenLabs などは全言語、Deepgram / Mistral は公表の言語だけを対応とする', () => {
    for (const id of ['local', 'openai', 'groq', 'elevenlabs', 'gemini', 'compatible']) expect(sttLanguageSupport(id, 'sw'), id).toBe('supported')
    expect(sttLanguageSupport('deepgram', 'ja')).toBe('supported')
    expect(sttLanguageSupport('deepgram', 'sw')).toBe('unsupported')
    expect(sttLanguageSupport('mistral', 'ja')).toBe('unsupported')
    expect(sttLanguageSupport('mistral', 'auto')).toBe('supported')
  })
})
