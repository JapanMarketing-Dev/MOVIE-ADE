/**
 * プロジェクトの HTML ファイルを内蔵ブラウザで開くときの URL の規則（純粋な関数。単体テストの対象）。
 *
 * HTML は Monaco（コード）ではなく、内蔵ブラウザのタブに ade-page://project/<相対パス> で開く（security-7 [2][6]）。
 *   - 中身は main が、いま開いているプロジェクトの中のファイルだけを返す（src/main/projectPage.ts。外・外を指すリンクは断る）。
 *     renderer は絶対パスの file:// を渡せない（URL 欄の file:// も受け付けない。webPolicy.ts の isTypedNavigationAllowed）
 *   - 外へは通信させない: 応答に CSP を付け（同じオリジンの中身・data: だけ）、ページが始めた外のページへの遷移・別タブも止める
 *     （外のページは、利用者が URL 欄に入れたときだけ開く）
 * renderer の iframe には出さない（アプリの画面と同じセッションに入れない）。
 * ade-preview:// でも返さない（あちらはプロジェクトのファイルを読める特権のスキームで、ファイルの中のスクリプトを動かさない約束）。
 */

export const PROJECT_PAGE_SCHEME = 'ade-page'
const PROJECT_PAGE_HOST = 'project'

/** 内蔵ブラウザでプレビューして開く HTML か（.html / .htm） */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/**
 * プロジェクトからの相対パスを、内蔵ブラウザで開く URL にする。区切りごとに符号化する（# ? % や空白を含む名前も開ける）。
 *   docs/index.html → ade-page://project/docs/index.html
 */
export function projectPageUrl(relPath: string): string {
  const segments = relPath.replace(/\\/g, '/').split('/').filter((s) => s.length > 0)
  return `${PROJECT_PAGE_SCHEME}://${PROJECT_PAGE_HOST}/${segments.map(encodeURIComponent).join('/')}`
}

/** プロジェクトのページ（ade-page://project/）の URL か */
export function isProjectPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${PROJECT_PAGE_SCHEME}:` && parsed.hostname === PROJECT_PAGE_HOST
  } catch {
    return false
  }
}

/**
 * 内蔵ブラウザの URL がプロジェクトのページなら、プロジェクトからの相対パスを返す。違えば null（クエリ・ハッシュは見ない）。
 * 「ソースを開く」のボタンを出すかの判定と、main がどのファイルを返すかに使う。
 * 空・`.`・`..` の区切り、符号化した区切り（%2F・%5C）、NUL は外へ出る形として null
 */
export function projectPathFromPageUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PROJECT_PAGE_SCHEME}:` || parsed.hostname !== PROJECT_PAGE_HOST) return null
  let segments: string[]
  try {
    segments = parsed.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) return null
  return segments.join('/')
}
