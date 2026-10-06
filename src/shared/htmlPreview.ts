/**
 * プロジェクトの HTML ファイルを内蔵ブラウザで開くときの URL の規則（純粋な関数。単体テストの対象）。
 *
 * HTML は Monaco（コード）ではなく、内蔵ブラウザのタブに file:// で開く（利用者が URL 欄に手元のファイルを入れたときと同じ経路。
 * 遷移・権限の決まりは src/main/webPolicy.ts の isTypedNavigationAllowed / isPageNavigationAllowed）。
 * renderer の iframe には出さない（アプリの画面と同じ file: のオリジンになり、preload の口に届きうるため）。
 * ade-preview:// でも返さない（あちらはプロジェクトのファイルを読める特権のスキームで、ファイルの中のスクリプトを動かさない約束）。
 */

/** 内蔵ブラウザでプレビューして開く HTML か（.html / .htm） */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** 区切りを / にそろえ、末尾の / を落とす（Windows の C:\a\b も C:/a/b にする） */
function slashed(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Windows のドライブ（C:/…）か UNC（//server/share）か。大文字小文字を区別しない比べ方にする */
function isWindowsLike(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

/**
 * プロジェクトのフォルダ（絶対パス）と相対パスから file:// の URL を作る。区切りごとに符号化する（# ? % や空白を含む名前も開ける）。
 *   /Users/taro/site + docs/index.html → file:///Users/taro/site/docs/index.html
 *   C:\work\site + index.html       → file:///C:/work/site/index.html
 *   \\server\share\site + a.html    → file://server/share/site/a.html
 */
export function projectFileUrl(root: string, relPath: string): string {
  const full = `${slashed(root)}/${relPath.replace(/\\/g, '/').replace(/^\/+/, '')}`
  const encode = (segments: string[]) => segments.map(encodeURIComponent).join('/')
  if (full.startsWith('//')) {
    const [host = '', ...rest] = full.slice(2).split('/')
    return `file://${encodeURIComponent(host)}/${encode(rest)}`
  }
  const drive = /^([A-Za-z]:)\//.exec(full)
  if (drive) return `file:///${drive[1]}/${encode(full.slice(3).split('/'))}`
  return `file://${encode(full.split('/'))}`
}

/**
 * 内蔵ブラウザの URL（file://）が、このプロジェクトの中のファイルなら相対パスを返す。違えば null（クエリ・ハッシュは見ない）。
 * 「ソースを開く」のボタンを出すかの判定に使う
 */
export function projectPathFromFileUrl(url: string, root: string | null): string | null {
  if (!root) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') return null
  let path: string
  try {
    path = parsed.pathname.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  if (parsed.host) path = `//${parsed.host}${path}`
  else if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  const base = slashed(root)
  const windows = isWindowsLike(base)
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (path.length <= base.length + 1 || !same(path.slice(0, base.length), base) || path[base.length] !== '/') return null
  const rel = path.slice(base.length + 1)
  // .. を含むものは中とみなさない（URL は正規化済みのはずだが、念のため）
  if (rel.split('/').some((segment) => segment === '..' || segment === '')) return null
  return rel
}
