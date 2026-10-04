/**
 * テストで文字列を正規表現に入れたり、HTML から一部を外したりするときの部品。
 * 正規表現の特殊文字のエスケープ漏れや、1回だけの置換で外し残す書き方（CodeQL の js/incomplete-sanitization・
 * js/incomplete-multi-character-sanitization・js/bad-tag-filter）をテストにも持ち込まない。
 */

/** 値を正規表現の中で文字どおりに合わせる（new RegExp に値を入れるときは必ず通す） */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** pattern に合う部分を、もう合わなくなるまで繰り返し外す（外したあとに新しくできた部分も残さない） */
function removeUntilStable(text: string, pattern: RegExp): string {
  let out = text
  let before: string
  do {
    before = out
    out = out.replace(pattern, '')
  } while (out !== before)
  return out
}

/** HTML のコメントを外す（--!> で閉じるものも。閉じていなければ末尾まで） */
export const withoutHtmlComments = (html: string): string => removeUntilStable(html, /<!--[\s\S]*?(?:--!?>|$)/g)

/** script 要素を外す（大文字・属性・閉じタグの中の空白も。閉じていなければ末尾まで） */
export const withoutScripts = (html: string): string => removeUntilStable(html, /<script\b[\s\S]*?(?:<\/script\b[^>]*>|$)/gi)
