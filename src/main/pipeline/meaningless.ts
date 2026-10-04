/**
 * 意味の通じない発話の判定（指摘にしない発話）。
 *
 * 文字起こし（Whisper など）は、無音や雑音から「Shh.」「Thank you.」「ご視聴ありがとうございました」のような
 * 言っていない文を作ることがある。これを指摘の見出し・要望にしない。判定した発話は「除外した発話」に入れ、
 * 「発話を指摘に戻す」で戻せるようにする（draft.ts・assemble.ts）。
 *
 * 決まり（発話の全体で判定する。部分一致では落とさない）:
 *   1. 空・空白・句読点・記号・絵文字・音符（♪）だけ → 意味なし
 *   2. 文字・数字が1字だけで、それがかな・ラテン文字（「ん」「あ」「w」）→ 意味なし。
 *      同じかな・ラテン文字の繰り返しだけ（「あああ」「www」）も意味なし。漢字・数字の1字（「赤」「5」）は残す
 *   3. 文字起こしがよく作る決まり文句（日本語・英語ほか。全体が一致したときだけ）→ 意味なし
 *      例: 「ご視聴ありがとうございました」「Thank you.」「Thanks for watching!」「you」「Subtitles by the Amara.org community」
 *   4. 音の注記だけ（「[Music]」「(笑)」「【拍手】」）→ 意味なし
 *   5. つなぎ言葉・間投詞だけ（「えー」「あの」「その」「うーん」「うん」「um」「uh」「hmm」「Shh」。並べたものも）→ 意味なし
 *   6. あいづち・返事だけ（「はい」「ええ」「OK」「Okay」「yes」）→ 指示を含まないので、書き込み（ペン・枠）が
 *      無いときだけ意味なし。書き込みがあれば、その印への返事として残す
 * 短くても指示になる言葉（「消して」「赤に」「ここ」「大きく」「No.」「Bigger」）は落とさない。
 */

export type MeaninglessKind = 'empty' | 'single' | 'hallucination' | 'sound' | 'filler' | 'acknowledgement'

interface MeaninglessOptions {
  /** この発話のまとまりに書き込み（ペン・枠）があるか。あれば返事（決まり6）は残す */
  hasAnnotation?: boolean
}

/** 発話が意味を持たないか（指摘の見出し・要望にしないか） */
export function isMeaninglessUtterance(text: string, options: MeaninglessOptions = {}): boolean {
  const kind = meaninglessKind(text)
  if (!kind) return false
  if (kind === 'acknowledgement') return !options.hasAnnotation
  return true
}

/** 意味を持たない理由の種類。意味があれば null。返事（acknowledgement）は書き込みの有無で扱いが変わる */
export function meaninglessKind(text: string): MeaninglessKind | null {
  const base = text.normalize('NFKC').toLowerCase()
  const letters = lettersOnly(base)
  if (!letters) return 'empty'
  if (isSingleOrRepeatedChar(letters)) return 'single'
  if (HALLUCINATIONS.has(letters) || HALLUCINATION_PATTERNS.some((re) => re.test(letters))) return 'hallucination'
  if (isSoundTag(base)) return 'sound'
  const tokens = base.split(/[^\p{L}\p{N}\p{M}ー〜~]+/u).map(foldKana).filter((s) => s.length > 0)
  if (tokens.length === 0) return 'empty'
  let ack = false
  for (const token of tokens) {
    if (ACKNOWLEDGEMENTS.has(token)) { ack = true; continue }
    if (isFillerToken(token)) continue
    // 区切りなしの返事（「はいはい」「okok」）
    if (isRepeatOf(token, ACKNOWLEDGEMENTS)) { ack = true; continue }
    // 英語の複数語の返事（「all right」）は全体で見る
    if (ACKNOWLEDGEMENTS.has(foldKana(letters)) && tokens.length > 1) return 'acknowledgement'
    return null
  }
  return ack ? 'acknowledgement' : 'filler'
}

/** 文字・数字（結合文字を含む）だけを残す。かなは揺れを寄せる */
function lettersOnly(s: string): string {
  return foldKana(s.replace(/[^\p{L}\p{N}\p{M}]+/gu, ''))
}

const SMALL_VOWELS: Record<string, string> = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ' }

/** ひらがな→カタカナ、小さい母音→大きい母音、長音・促音・波線を落とす（「えーっと」「えっと」「エト」、「あぁ」「アア」を同じにする） */
function foldKana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[ァィゥェォ]/g, (c) => SMALL_VOWELS[c]!)
    .replace(/[ーッ〜~]/g, '')
}

const KANA_OR_LATIN = /^[\p{Script=Katakana}\p{Script=Hiragana}a-z]$/u

/** かな・ラテン文字の1字だけ、または同じ字の3回以上の繰り返し（「ん」「w」「あああ」「www」）。「ここ」のような2字は残す */
function isSingleOrRepeatedChar(s: string): boolean {
  const chars = [...s]
  const first = chars[0]!
  if (!KANA_OR_LATIN.test(first) || !chars.every((c) => c === first)) return false
  return chars.length === 1 || chars.length >= 3
}

/** 全体を同じ語の繰り返しに分けられるか（「ハイハイ」「okok」） */
function isRepeatOf(token: string, words: Set<string>): boolean {
  for (const w of words) {
    if (w.length > 0 && token.length > w.length && token.length % w.length === 0 && w.repeat(token.length / w.length) === token) return true
  }
  return false
}

/*
 * 文字起こしの決まり文句。lettersOnly で正規化した形で持つ（句読点・空白・大文字小文字の違いは同じ）。
 * 発話の全体が一致したときだけ意味なしにする。
 */
const HALLUCINATION_PHRASES = [
  // 日本語
  'ご視聴ありがとうございました', 'ご視聴ありがとうございます', '最後までご視聴いただきありがとうございました',
  'ありがとうございました', 'ありがとうございます', 'チャンネル登録よろしくお願いします', 'チャンネル登録お願いします',
  'チャンネル登録と高評価よろしくお願いします', '次回もお楽しみに', 'おやすみなさい', 'お疲れ様でした',
  // 英語
  'you', 'thank you', 'thank you very much', 'thank you so much', 'thanks', 'thanks for watching', 'thank you for watching',
  'thank you so much for watching', 'thank you for listening', 'thanks for listening', 'please subscribe', 'like and subscribe',
  'subscribe to my channel', 'please like and subscribe', 'see you next time', 'see you in the next video', 'bye', 'bye bye',
  'the end', 'music', 'applause', 'laughter', 'silence', 'blank audio', 'blankaudio', 'inaudible',
  // 中国語・韓国語
  '谢谢观看', '感谢观看', '謝謝觀看', '感謝觀看', '谢谢大家', '請訂閱', '请订阅', '시청해주셔서 감사합니다', '구독과 좋아요 부탁드립니다',
  // ドイツ語・フランス語・スペイン語・ポルトガル語・イタリア語・ロシア語
  'vielen dank fürs zuschauen', 'danke fürs zuschauen', "merci d'avoir regardé", 'merci de votre attention',
  'gracias por ver', 'gracias por ver el video', 'suscríbete', 'obrigado por assistir', 'grazie per la visione',
  'спасибо за просмотр', 'продолжение следует',
]
const HALLUCINATIONS = new Set(HALLUCINATION_PHRASES.map((p) => lettersOnly(p.normalize('NFKC').toLowerCase())))

/** 字幕の名乗り（「Subtitles by the Amara.org community」「Untertitel im Auftrag des ZDF」など）。全体が字幕の名乗りのとき */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /amaraorg/u,
  /^(subtitles|captions)by/u,
  /^untertitelimauftrag/u,
  /^субтитры(сделал|создавал|подготовил)/u,
]

/** 音の注記の中身（括弧の中だけ見る） */
const SOUND_TAGS = new Set([
  'music', 'applause', 'laughter', 'laughs', 'laughing', 'silence', 'blankaudio', 'blank audio', 'noise', 'inaudible', 'sighs',
  'coughs', 'cough', 'background noise', 'no speech', 'speaking foreign language', 'foreign language',
  '音楽', '拍手', '笑', '笑い', '無音', '咳', '音声なし', '雑音', '沈黙', 'bgm',
].map((s) => lettersOnly(s)))

/** 全体が括弧で囲んだ音の注記（「[Music]」「(笑)」「【拍手】」「♪〜♪」）か */
function isSoundTag(s: string): boolean {
  const m = s.trim().match(/^[[(（【<*]+(.+?)[\])）】>*]+$/u)
  if (!m) return false
  return SOUND_TAGS.has(lettersOnly(m[1]!))
}

/* つなぎ言葉（foldKana した形）。区切りなしで並べた「エトアノ」も分けて見る */
const FILLERS_JA = ['エ', 'ア', 'ン', 'オ', 'エト', 'エエト', 'アノ', 'アノウ', 'ソノ', 'ウン', 'ンン', 'ウム', 'マア', 'ナンカ', 'エトネ', 'アノネ']
const FILLER_SET_JA = new Set(FILLERS_JA)
/* 区切りなしの並びで使う語。1字の語は入れない（「ウ」+「エ」が「上」になるなど、意味のある語を作れてしまう） */
const FILLER_JOINABLE = FILLERS_JA.filter((w) => w.length >= 2)
const FILLER_EN = /^(u+m+|u+h+m*|e+r+m*|e+r+|h+m+|m+h+m+|m+|a+h+|o+h+|e+h+|s+h+|p+s+t+|h+u+h+|a+h+a+|o+o+p+s+)$/u

function isFillerToken(token: string): boolean {
  if (FILLER_SET_JA.has(token) || FILLER_EN.test(token)) return true
  // 1字のつなぎ言葉の繰り返し（「あぁ」→「アア」「んん」）
  const chars = [...token]
  if (chars.length > 1 && FILLER_SET_JA.has(chars[0]!) && chars[0]!.length === 1 && chars.every((c) => c === chars[0])) return true
  return splitsInto(token, FILLER_JOINABLE)
}

/** token を words の語だけの並びに分けられるか */
function splitsInto(token: string, words: string[]): boolean {
  const ok: boolean[] = new Array<boolean>(token.length + 1).fill(false)
  ok[0] = true
  for (let i = 0; i < token.length; i++) {
    if (!ok[i]) continue
    for (const w of words) if (token.startsWith(w, i)) ok[i + w.length] = true
  }
  return ok[token.length]!
}

/* 返事・あいづち（foldKana した形）。書き込みがあれば残す（決まり6） */
const ACKNOWLEDGEMENTS = new Set(['ハイ', 'エエ', 'ok', 'okay', 'okey', 'yes', 'yeah', 'yep', 'yup', 'alright', 'allright', 'right', 'sure'])
