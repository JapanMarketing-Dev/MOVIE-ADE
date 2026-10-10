/**
 * Markdown のプレビュー（編集できる表示）のリンク。押すと外部のブラウザで開く（main の app:openExternal。https だけを通す）。
 * 画面に依存しない純粋な処理だけを置く
 */

/** 押した要素からリンクの先を探す。リンクでなければ null。ページ内の #… と相対パスは開かない */
export function clickedLinkHref(target: EventTarget | null): string | null {
  const el = target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null
  const a = el && typeof el.closest === 'function' ? el.closest('a[href]') : null
  const href = a?.getAttribute('href')?.trim()
  if (!href || !/^https?:\/\//i.test(href)) return null
  return href
}
