/**
 * 端末の中のプログラムが OSC 52 で求めたコピー。
 *
 * 確認の帯は出さずにそのまま写す（製品の判断。以前の「毎回確認する」帯と terminalClipboard の設定はやめた）。
 * 確認以外の安全策は残す:
 *   - 大きすぎるもの・空・文字列でないものは写さない
 *   - アプリの窓にフォーカスが無いとき（利用者が別のアプリを使っている間）は写さない。裏で動くプログラムに
 *     利用者の知らないうちにクリップボードを書き換えさせないため
 *   - 読み出しの問い合わせには答えない・流し直しの間は写さない（renderer の terminalOsc52.ts・terminalClient.ts）
 */

/** 写す文字数の上限（OSC 52 は base64 で 128K 文字まで。terminalOsc52.ts） */
export const PROGRAM_COPY_MAX_CHARS = 128 * 1024

/** 写してよければ写す文字列を、そうでなければ null を返す */
export function programCopyText(text: unknown, input: { windowFocused: boolean }): string | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > PROGRAM_COPY_MAX_CHARS) return null
  return input.windowFocused ? text : null
}
