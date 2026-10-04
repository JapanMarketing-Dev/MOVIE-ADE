/**
 * Agent や LLM へ渡す文に、外から来た文字を差し込むときの整え方（NF-14 / セキュリティの指摘 [9]）。
 *
 * ページのタイトル・URL・要素の文字・selector はレビューしたページの作者が自由に書ける。整理の LLM の出力
 * （見出し・要望）も、その文字に引きずられうる。これらを feedback.md や整理のプロンプトへそのまま入れると、
 * 改行で偽の見出し（「## 進み具合」など）や偽の指示の節を作ったり、コードの囲みを閉じたり、
 * 制御文字でターミナルの表示を書き換えたりできる。そこで:
 *   - 制御文字・文字の向きを変える bidi の制御文字・幅の無い文字を除く
 *   - 1行にまとめる（Markdown の見出し・リスト・囲みは行頭でしか効かないので、改行が無ければ作れない）
 *   - インラインのコード（`）と HTML（<）はエスケープする
 *   - 長さの上限で切る
 * 中身の言葉は変えない（「前の指示を無視して」のような文を消すのは validate の役目。ここは形を崩させないだけ）。
 */

/** 除く文字。タブ・改行（\t \n \r）は oneLine で空白にする。ZWJ / ZWNJ（U+200C/D）は絵文字やヒンディー語で要るので残す */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
/** 改行として扱う文字（行区切り U+2028・段落区切り U+2029 も） */
const LINE_BREAKS = /[\t\r\n\u2028\u2029]+/g

/** 制御文字などを除く（改行は残す） */
function stripControls(text: string): string {
  return text.replace(CONTROL, '')
}

/** 1行にまとめ、上限で切る（上限を超えたら末尾に …） */
export function oneLine(text: string | undefined, max = 2000): string {
  const line = stripControls(text ?? '').replace(LINE_BREAKS, ' ').replace(/ {2,}/g, ' ').trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

/**
 * Markdown の1行の中に差し込む文。1行にまとめ、` と < をエスケープする。
 * 見出し・要望・発話・コメントなど、feedback.md の「- 要望: …」のような行の中に入れる値に使う
 */
export function mdText(text: string | undefined, max = 2000): string {
  return oneLine(text, max).replace(/\\(?=[`<])/g, '\\\\').replace(/`/g, '\\`').replace(/</g, '\\<')
}

/**
 * 既にバッククォートで囲む位置（`{{selector}}` など）へ入れる値。囲みを閉じさせないよう ` を ' に替える。
 * selector や ID のように、エスケープの \ が混ざると読みにくい値に使う
 */
export function mdCodeValue(text: string | undefined, max = 300): string {
  return oneLine(text, max).replace(/`/g, "'")
}

/**
 * Agent がシェルのコマンド（"…" で囲んだ URL など）に書き写しうる URL。シェルで意味を持つ文字を %XX にする。
 * ブラウザの URL は " や空白は既に %XX だが、$ ( ) ` などは残るので、"$(…)" で任意のコマンドになりうる。
 * クエリの区切り（? & =）と # は意味が変わるので残す（"…" の中ではシェルの意味を持たない）
 */
export function shellSafeUrl(url: string): string {
  return oneLine(url, 2000).replace(/[$`"'\\!;|<>(){}\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}
