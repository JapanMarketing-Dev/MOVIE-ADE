/**
 * 書き込み（ペン・テキスト）が属する「ページ」の判定（PEN-3 / TXT-2 の拡張）。
 *
 * 書き込みはその画面だけのもので、ページが変わったら新しいページへ引き継がない。
 * 「ページが変わった」は、オリジン・パス・クエリのどれかが変わったとき。
 * ハッシュがルートの形（`#/users`・`#!/users`）なら、ハッシュルーターの画面遷移なので、それも別のページ。
 * それ以外のハッシュ（`#section` などページ内のアンカー）だけの変化は、同じページとして残す。
 *
 * Electron に依存しない純粋な処理だけを置く。呼び出しは controller.ts と注入スクリプト（preload/review.ts）。
 */

/** ハッシュルーターのルートか（`#/…` か `#!/…`） */
export function isHashRoute(hash: string): boolean {
  return /^#!?\//.test(hash)
}

/**
 * ページを表すキー。ページ内のアンカーは落とし、ハッシュルートは残す。
 * URLとして読めなければ文字列のまま同じ規則で扱う。
 */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url)
    const route = isHashRoute(parsed.hash) ? parsed.hash : ''
    // 末尾の「?」だけの違い（? の有無）は同じページとみなす
    // file: や ade-preview:（ファイルのプレビュー）は origin が 'null' になるので、スキームとホストで表す
    return `${parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin}${parsed.pathname}${parsed.search}${route}`
  } catch {
    const index = url.indexOf('#')
    if (index < 0) return url
    return isHashRoute(url.slice(index)) ? url : url.slice(0, index)
  }
}

/**
 * 前のURLから次のURLへの移動で、ページが変わったか。
 * 前のURLが無い（録画開始直後・初回表示）ときは変わっていない扱いにする。
 */
export function isPageChange(previous: string | null | undefined, next: string): boolean {
  if (!previous || previous === 'about:blank') return false
  return pageKey(previous) !== pageKey(next)
}
