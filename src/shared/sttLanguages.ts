/**
 * 文字起こしの言語（CapturePreferences.language）。画面の言語（src/shared/i18n）とは別の軸。
 *
 * 一覧は whisper が対応する言語（openai/whisper の tokenizer.py の LANGUAGES、whisper.cpp も同じ）。
 * コードは ISO 639-1。639-1 を持たないものだけ 639-3（haw / yue）。
 * whisper は Javanese を独自に 'jw' と呼ぶので、ここでは ISO の 'jv' を正本にし、whisper.cpp へ渡すときだけ直す。
 * 名前は「その言語自身の表記」と「英語名」。どの画面の言語でも同じ並びで出す（検索しやすいように）。
 */

export interface SttLanguageInfo {
  code: string
  /** 英語名 */
  english: string
  /** その言語自身の表記 */
  native: string
}

export const STT_LANGUAGES: readonly SttLanguageInfo[] = [
  { code: 'af', english: 'Afrikaans', native: 'Afrikaans' },
  { code: 'am', english: 'Amharic', native: 'አማርኛ' },
  { code: 'ar', english: 'Arabic', native: 'العربية' },
  { code: 'as', english: 'Assamese', native: 'অসমীয়া' },
  { code: 'az', english: 'Azerbaijani', native: 'Azərbaycan' },
  { code: 'ba', english: 'Bashkir', native: 'Башҡорт' },
  { code: 'be', english: 'Belarusian', native: 'Беларуская' },
  { code: 'bg', english: 'Bulgarian', native: 'Български' },
  { code: 'bn', english: 'Bengali', native: 'বাংলা' },
  { code: 'bo', english: 'Tibetan', native: 'བོད་སྐད་' },
  { code: 'br', english: 'Breton', native: 'Brezhoneg' },
  { code: 'bs', english: 'Bosnian', native: 'Bosanski' },
  { code: 'ca', english: 'Catalan', native: 'Català' },
  { code: 'cs', english: 'Czech', native: 'Čeština' },
  { code: 'cy', english: 'Welsh', native: 'Cymraeg' },
  { code: 'da', english: 'Danish', native: 'Dansk' },
  { code: 'de', english: 'German', native: 'Deutsch' },
  { code: 'el', english: 'Greek', native: 'Ελληνικά' },
  { code: 'en', english: 'English', native: 'English' },
  { code: 'es', english: 'Spanish', native: 'Español' },
  { code: 'et', english: 'Estonian', native: 'Eesti' },
  { code: 'eu', english: 'Basque', native: 'Euskara' },
  { code: 'fa', english: 'Persian', native: 'فارسی' },
  { code: 'fi', english: 'Finnish', native: 'Suomi' },
  { code: 'fo', english: 'Faroese', native: 'Føroyskt' },
  { code: 'fr', english: 'French', native: 'Français' },
  { code: 'gl', english: 'Galician', native: 'Galego' },
  { code: 'gu', english: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'ha', english: 'Hausa', native: 'Hausa' },
  { code: 'haw', english: 'Hawaiian', native: 'ʻŌlelo Hawaiʻi' },
  { code: 'he', english: 'Hebrew', native: 'עברית' },
  { code: 'hi', english: 'Hindi', native: 'हिन्दी' },
  { code: 'hr', english: 'Croatian', native: 'Hrvatski' },
  { code: 'ht', english: 'Haitian Creole', native: 'Kreyòl ayisyen' },
  { code: 'hu', english: 'Hungarian', native: 'Magyar' },
  { code: 'hy', english: 'Armenian', native: 'Հայերեն' },
  { code: 'id', english: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'is', english: 'Icelandic', native: 'Íslenska' },
  { code: 'it', english: 'Italian', native: 'Italiano' },
  { code: 'ja', english: 'Japanese', native: '日本語' },
  { code: 'jv', english: 'Javanese', native: 'Basa Jawa' },
  { code: 'ka', english: 'Georgian', native: 'ქართული' },
  { code: 'kk', english: 'Kazakh', native: 'Қазақ' },
  { code: 'km', english: 'Khmer', native: 'ខ្មែរ' },
  { code: 'kn', english: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ko', english: 'Korean', native: '한국어' },
  { code: 'la', english: 'Latin', native: 'Latina' },
  { code: 'lb', english: 'Luxembourgish', native: 'Lëtzebuergesch' },
  { code: 'ln', english: 'Lingala', native: 'Lingála' },
  { code: 'lo', english: 'Lao', native: 'ລາວ' },
  { code: 'lt', english: 'Lithuanian', native: 'Lietuvių' },
  { code: 'lv', english: 'Latvian', native: 'Latviešu' },
  { code: 'mg', english: 'Malagasy', native: 'Malagasy' },
  { code: 'mi', english: 'Maori', native: 'Te Reo Māori' },
  { code: 'mk', english: 'Macedonian', native: 'Македонски' },
  { code: 'ml', english: 'Malayalam', native: 'മലയാളം' },
  { code: 'mn', english: 'Mongolian', native: 'Монгол' },
  { code: 'mr', english: 'Marathi', native: 'मराठी' },
  { code: 'ms', english: 'Malay', native: 'Bahasa Melayu' },
  { code: 'mt', english: 'Maltese', native: 'Malti' },
  { code: 'my', english: 'Burmese', native: 'မြန်မာ' },
  { code: 'ne', english: 'Nepali', native: 'नेपाली' },
  { code: 'nl', english: 'Dutch', native: 'Nederlands' },
  { code: 'nn', english: 'Norwegian Nynorsk', native: 'Nynorsk' },
  { code: 'no', english: 'Norwegian', native: 'Norsk' },
  { code: 'oc', english: 'Occitan', native: 'Occitan' },
  { code: 'pa', english: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'pl', english: 'Polish', native: 'Polski' },
  { code: 'ps', english: 'Pashto', native: 'پښتو' },
  { code: 'pt', english: 'Portuguese', native: 'Português' },
  { code: 'ro', english: 'Romanian', native: 'Română' },
  { code: 'ru', english: 'Russian', native: 'Русский' },
  { code: 'sa', english: 'Sanskrit', native: 'संस्कृतम्' },
  { code: 'sd', english: 'Sindhi', native: 'سنڌي' },
  { code: 'si', english: 'Sinhala', native: 'සිංහල' },
  { code: 'sk', english: 'Slovak', native: 'Slovenčina' },
  { code: 'sl', english: 'Slovenian', native: 'Slovenščina' },
  { code: 'sn', english: 'Shona', native: 'chiShona' },
  { code: 'so', english: 'Somali', native: 'Soomaali' },
  { code: 'sq', english: 'Albanian', native: 'Shqip' },
  { code: 'sr', english: 'Serbian', native: 'Српски' },
  { code: 'su', english: 'Sundanese', native: 'Basa Sunda' },
  { code: 'sv', english: 'Swedish', native: 'Svenska' },
  { code: 'sw', english: 'Swahili', native: 'Kiswahili' },
  { code: 'ta', english: 'Tamil', native: 'தமிழ்' },
  { code: 'te', english: 'Telugu', native: 'తెలుగు' },
  { code: 'tg', english: 'Tajik', native: 'Тоҷикӣ' },
  { code: 'th', english: 'Thai', native: 'ไทย' },
  { code: 'tk', english: 'Turkmen', native: 'Türkmen' },
  { code: 'tl', english: 'Tagalog', native: 'Tagalog' },
  { code: 'tr', english: 'Turkish', native: 'Türkçe' },
  { code: 'tt', english: 'Tatar', native: 'Татар' },
  { code: 'uk', english: 'Ukrainian', native: 'Українська' },
  { code: 'ur', english: 'Urdu', native: 'اردو' },
  { code: 'uz', english: 'Uzbek', native: 'Oʻzbek' },
  { code: 'vi', english: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'yi', english: 'Yiddish', native: 'ייִדיש' },
  { code: 'yo', english: 'Yoruba', native: 'Yorùbá' },
  { code: 'yue', english: 'Cantonese', native: '粵語' },
  { code: 'zh', english: 'Chinese', native: '中文' }
]

/** 'auto' か STT_LANGUAGES のコード */
export type SttLanguageCode = 'auto' | (string & {})

export const STT_LANGUAGE_CODES: readonly string[] = STT_LANGUAGES.map((l) => l.code)
const BY_CODE = new Map(STT_LANGUAGES.map((l) => [l.code, l]))

export function sttLanguageInfo(code: string): SttLanguageInfo | undefined {
  return BY_CODE.get(code)
}

/**
 * 保存値の検査。大文字・地域つき（pt-BR）・whisper の別名（jw）も一覧のコードへ寄せる。
 * 空・知らない値は auto（英語扱いにしない）。
 */
export function normalizeSttLanguage(value: unknown): SttLanguageCode {
  if (typeof value !== 'string') return 'auto'
  const v = value.trim().toLowerCase().replace(/_/g, '-')
  if (!v || v === 'auto') return 'auto'
  if (v === 'jw') return 'jv'
  if (BY_CODE.has(v)) return v
  const primary = v.split('-')[0]!
  return BY_CODE.has(primary) ? primary : 'auto'
}

/** whisper（whisper.cpp / openai-whisper）に渡すコード。Javanese だけ whisper 独自の 'jw' */
export function toWhisperLanguage(code: SttLanguageCode): string {
  return code === 'jv' ? 'jw' : code
}

/** 「自称 (English)」。自称と英語名が同じなら1つだけ */
export function sttLanguageLabel(info: SttLanguageInfo): string {
  return info.native === info.english ? info.native : `${info.native} (${info.english})`
}

/** 検索の一致。コード・英語名・自称のどれか（大文字小文字・アクセントを無視） */
export function matchesSttLanguage(info: SttLanguageInfo, query: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const q = fold(query.trim())
  if (!q) return true
  return [info.code, info.english, info.native].some((s) => fold(s).includes(q))
}

// ---- 提供元ごとの対応 ----

/**
 * 公表されている対応言語が whisper より狭い提供元だけを持つ。
 * 載っていない提供元（whisper 系・ElevenLabs Scribe・Gemini など）は一覧の全言語を受け付ける。
 * 表は目安で、送信は止めない（対応外の可能性があると注記するだけ）。
 *   Deepgram … nova-2 / nova-3 の公表言語（https://developers.deepgram.com/docs/models-languages-overview）
 *   Mistral Voxtral … 公表の得意言語（英・西・仏・葡・印・独・蘭・伊）
 */
const PROVIDER_LANGUAGES: Record<string, readonly string[]> = {
  deepgram: ['bg', 'ca', 'zh', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'lv', 'lt', 'ms', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'es', 'sv', 'th', 'tr', 'uk', 'vi'],
  mistral: ['en', 'es', 'fr', 'pt', 'hi', 'de', 'nl', 'it']
}

export type SttLanguageSupport = 'supported' | 'unsupported'

/** presetId は aiProviders.ts の STT のプリセットの id（'local' は端末内の whisper） */
export function sttLanguageSupport(presetId: string, code: SttLanguageCode): SttLanguageSupport {
  if (code === 'auto') return 'supported'
  const list = PROVIDER_LANGUAGES[presetId]
  return !list || list.includes(code) ? 'supported' : 'unsupported'
}
