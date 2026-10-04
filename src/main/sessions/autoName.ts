/**
 * 履歴の見出しに使う、自動の名前（例「ヘッダーと余白の修正」「Login form fixes」）。
 *
 * ページのタイトル（「X. It's what's happening / X」など）では何の修正のレビューか分からないので、
 * 指摘の中身から「何系の修正か」が分かる短い名前を作る。利用者が付けた名前（label.json の name）は
 * 別の値で、見出しは「手の名前 → 自動の名前 → ページのタイトル」の順に出す（shared/reviewList.ts）。
 *
 * - 既定はルールだけで作る（LLM を呼ばない。開発者も利用者も費用を負担しない）
 *   - 指摘が1件なら、その見出しを短くしたもの
 *   - 2件以上なら、2件以上の指摘に出る語（要素や話題）の多い順に2つまで ＋「の修正」
 *   - 共通の語が無ければ「最初の見出し ほかN件」
 * - 利用者が「整理」を実行したときは、整理の出力の review_title を使う（その後に指摘を編集したら
 *   ルールの名前に戻す。sessions/summary.ts）
 * - 効果音のタグ・無音への決まり文句（whisper の幻覚）だけの文は使わない
 * - 名前の言語は、指摘の文の文字から決める（日本語・韓国語など）。決められなければ画面の言語
 *
 * Electron に依存しない純粋な処理（単体テストから使う）。
 */
import { translate, type SupportedLocale } from '@shared/i18n'
import { isSilencePhrase, stripSoundTags } from '../pipeline/stt/hallucination'
import { oneLine } from '../pipeline/mdSafe'

/** 自動の名前の長さの上限。一覧の見出しなので短く */
export const AUTO_NAME_MAX = 60
/** 指摘1件の見出しを短くするときの上限（文字数）。CJK は1文字の情報が多いので短め */
const SHORT_CJK = 24
const SHORT_LATIN = 48

export interface AutoNameItem {
  title: string
  request: string
  quotes: Array<{ text: string }>
}

/** 意味のある本文だけを返す。効果音のタグ・無音への決まり文句だけなら空文字 */
function meaningfulText(text: string | undefined): string {
  // 制御文字・改行も除く（一覧の見出しと検索の本文に入る）
  const stripped = stripSoundTags(oneLine(text))
  if (!stripped || isSilencePhrase(stripped)) return ''
  return stripped
}

// ---- 言語 ----

const LATIN_LOCALES = new Set<SupportedLocale>(['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'vi', 'id'])
/** 英語の文と見分けるための機能語 */
const EN_FUNCTION_WORDS = new Set(['the', 'is', 'are', 'this', 'that', 'it', 'and', 'to', 'of', 'should', 'too', 'please', 'make', 'can', 'not'])

/** 名前の言語。文の文字から決め、決められなければ画面の言語 */
export function nameLocale(texts: readonly string[], uiLocale: SupportedLocale): SupportedLocale {
  const text = texts.join('\n')
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja'
  if (/\p{Script=Hangul}/u.test(text)) return 'ko'
  if (/\p{Script=Han}/u.test(text)) return uiLocale === 'zh-CN' || uiLocale === 'zh-TW' || uiLocale === 'ja' ? uiLocale : 'zh-CN'
  if (/\p{Script=Cyrillic}/u.test(text)) return 'ru'
  if (/\p{Script=Devanagari}/u.test(text)) return 'hi'
  if (/\p{Script=Latin}/u.test(text)) {
    if (!LATIN_LOCALES.has(uiLocale)) return 'en'
    if (uiLocale === 'en') return 'en'
    // 画面がラテン文字の言語でも、英語で話していれば英語
    const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
    return words.filter((w) => EN_FUNCTION_WORDS.has(w)).length >= 2 ? 'en' : uiLocale
  }
  return uiLocale
}

// ---- 語を拾う ----

/** 話題にならない語（日本語） */
const JA_STOP = new Set(['修正', '変更', '対応', '確認', '部分', '感じ', '場合', '必要', '全体', '少し', '今回', '問題', '画面', '表示', '気', '方', '時', '事', '中', '上', '下', '前', '後', '今', '次', '所', '他', '方向'])
/** 動詞（う段）・形容詞（い）の終止形の語尾。漢字やカタカナの後ろに付いたひらがなで見る */
const JA_PREDICATE_END = /[うくすつぬふむゆるぐずづぶぷい]$/u
/** 1文字でも話題になる漢字（UIの部品・性質） */
const JA_SINGLE = new Set(['色', '枠', '幅', '行', '欄', '字', '線', '影', '図', '表', '絵', '角', '列', '縦', '横', '端'])
/** 話題にならない語（英語） */
const EN_STOP = new Set([...EN_FUNCTION_WORDS, 'a', 'an', 'be', 'was', 'were', 'for', 'with', 'on', 'in', 'at', 'by', 'from', 'as', 'or', 'but', 'if', 'so',
  'we', 'you', 'they', 'its', 'there', 'here', 'more', 'less', 'very', 'bit', 'little', 'just', 'also', 'some', 'all', 'any', 'one', 'two',
  'fix', 'fixes', 'change', 'changes', 'update', 'issue', 'need', 'needs', 'want', 'like', 'looks', 'look', 'seems', 'feel', 'feels',
  'should', 'could', 'would', 'will', 'have', 'has', 'had', 'does', 'do', 'did', 'get', 'got', 'use', 'used', 'page', 'screen', 'thing', 'things',
  'now', 'then', 'than', 'when', 'what', 'which', 'how', 'why', 'into', 'out', 'up', 'down', 'about', 'right', 'left', 'maybe', 'really', 'add', 'remove',
  // 動詞の原形と、程度だけを言う形容詞（「Make fixes」「Bigger fixes」のような名前にしない）
  'make', 'move', 'put', 'set', 'keep', 'show', 'hide', 'increase', 'decrease', 'reduce', 'enlarge', 'shrink', 'expand', 'align', 'center',
  'adjust', 'improve', 'explain', 'delete', 'replace', 'rename', 'change', 'fixed', 'try', 'see', 'go', 'take', 'give', 'let', 'say', 'tell',
  'work', 'works', 'working', 'click', 'clicked', 'open', 'close', 'check', 'shows', 'showing', 'display', 'appear', 'appears',
  'big', 'bigger', 'small', 'smaller', 'large', 'larger', 'tiny', 'too', 'much', 'many', 'good', 'bad', 'better', 'worse', 'new', 'old',
  'hard', 'easy', 'unclear', 'clear', 'wrong', 'strange', 'weird', 'nice', 'different', 'same', 'other', 'another'])

function isTopicWord(word: string, locale: SupportedLocale): boolean {
  if (/^\p{N}+$/u.test(word)) return false
  if (locale === 'ja' || locale === 'zh-CN' || locale === 'zh-TW') {
    if (JA_STOP.has(word)) return false
    // ひらがなだけの語（助詞・活用の語尾）は話題にならない
    if (!/[\p{Script=Han}\p{Script=Katakana}\p{Script=Latin}\p{N}]/u.test(word)) return false
    // 動詞・形容詞の終止形（「申し込む」「大きい」）は名前にすると不自然なので、名詞らしい語だけにする
    if (JA_PREDICATE_END.test(word)) return false
    if (/\p{Script=Han}/u.test(word)) return word.length >= 2 || JA_SINGLE.has(word)
    return word.length >= 2
  }
  if (locale === 'en') return word.length >= 3 && !EN_STOP.has(word.toLowerCase())
  // ほかの言語は機能語の一覧を持たないので、短い語を除くだけ
  return [...word].length >= 4
}

/** 文から話題の語を拾う（重複なし。見つけた順） */
function topicWords(text: string, locale: SupportedLocale): string[] {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  const out: string[] = []
  for (const s of segmenter.segment(text)) {
    if (!s.isWordLike) continue
    const word = s.segment.trim()
    if (word && isTopicWord(word, locale) && !out.some((w) => w.toLowerCase() === word.toLowerCase())) out.push(word)
  }
  return out
}

// ---- 名前を組み立てる ----

function isCjk(locale: SupportedLocale): boolean {
  return locale === 'ja' || locale === 'zh-CN' || locale === 'zh-TW' || locale === 'ko'
}

/** 1行にまとめ、上限で切る（ラテン文字は語の途中で切らない） */
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim().replace(/[。.!?！？、,]+$/u, '')
  const chars = [...line]
  if (chars.length <= max) return line
  let cut = chars.slice(0, max - 1).join('')
  const space = cut.lastIndexOf(' ')
  if (space > max / 2) cut = cut.slice(0, space)
  return `${cut.replace(/[\s、,]+$/u, '')}…`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** 指摘1件を名前の材料にする。見出し → 要望 → 発話の順に、意味のあるものを使う */
function itemText(item: AutoNameItem): string {
  return meaningfulText(item.title) || meaningfulText(item.request) || item.quotes.map((q) => meaningfulText(q.text)).find(Boolean) || ''
}

/** 整理の出力の review_title を名前に使える形にする。使えなければ undefined */
export function cleanReviewTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = meaningfulText(raw)
  return text ? shorten(text, AUTO_NAME_MAX) : undefined
}

/**
 * 指摘から自動の名前を作る。作れない（指摘が無い・意味のある文が無い）ときは undefined
 * （見出しはページのタイトルのままになる）。
 */
export function buildAutoName(items: readonly AutoNameItem[], uiLocale: SupportedLocale): string | undefined {
  const usable = items.map((item) => ({ item, text: itemText(item) })).filter((x) => x.text)
  if (usable.length === 0) return undefined
  const locale = nameLocale(usable.map((x) => x.text), uiLocale)
  const shortMax = isCjk(locale) ? SHORT_CJK : SHORT_LATIN
  if (usable.length === 1) return shorten(usable[0]!.text, shortMax)

  // 語ごとに、いくつの指摘に出るか（見出しと要望）。指した要素の表示テキストはページの作者が書ける文字なので使わない
  const counts = new Map<string, { word: string; count: number; first: number }>()
  usable.forEach(({ item }, index) => {
    const text = [meaningfulText(item.title), meaningfulText(item.request)].join('\n')
    for (const word of topicWords(text, locale)) {
      const key = word.toLowerCase()
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { word, count: 1, first: index })
    }
  })
  const topics = [...counts.values()]
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, 2)
    .map((e) => e.word)
  if (topics.length > 0) {
    const joined = topics.length === 2 ? translate(locale, 'review.autoName.and', { a: topics[0], b: topics[1] }) : topics[0]!
    const name = translate(locale, 'review.autoName.topics', { topics: joined })
    return shorten(locale === 'en' ? capitalize(name) : name, AUTO_NAME_MAX)
  }
  // 共通の話題が無ければ、最初の指摘と残りの件数
  const first = shorten(usable[0]!.text, Math.floor(shortMax * 0.75))
  return shorten(translate(locale, 'review.autoName.more', { title: first, count: String(usable.length - 1) }), AUTO_NAME_MAX)
}
