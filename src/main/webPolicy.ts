/**
 * 内蔵ブラウザ・メインウィンドウの「Web の内容に何を許すか」の決まり。
 *
 * - 権限（マイク・カメラ・位置・通知・MIDI・クリップボード・画面共有・外部アプリの起動 …）は既定ですべて断る。
 *   許すものは呼び出し側が名前と条件で明示する（installPermissionPolicy）
 * - 別のアプリ（OS の URL ハンドラ）へ渡せるのは http / https / mailto だけ。file: data: javascript: や
 *   独自スキーム（zoommtg: など）は渡さない。表示中のページが求めたものは、確認を出して利用者が選んだときだけ渡す
 *
 * Electron に依存させない（単体テストで偽の session を渡して確かめるため）。
 */
import { PREVIEW_SCHEME } from '@shared/preview'
import { PROJECT_PAGE_SCHEME, isProjectPageUrl } from '@shared/htmlPreview'
import { isPresetableUrl } from '@shared/projectUrl'

/** session の権限ハンドラの最小の形（Electron の Session の一部） */
export interface PermissionSessionLike {
  setPermissionRequestHandler(handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details: PermissionDetails) => void) | null): void
  setPermissionCheckHandler(handler: ((webContents: unknown, permission: string, requestingOrigin: string, details: PermissionDetails) => boolean) | null): void
}

export interface PermissionDetails {
  requestingUrl?: string
  isMainFrame?: boolean
  mediaTypes?: string[]
  externalURL?: string
  [key: string]: unknown
}

interface PermissionQuery {
  permission: string
  /** 求めたページ（フレーム）の URL かオリジン */
  origin: string
  /** request のときだけ true。check（navigator.permissions など）は false */
  request: boolean
  isMainFrame: boolean | undefined
  mediaTypes: string[]
  webContents: unknown
  details: PermissionDetails
}

/**
 * session に権限の決まりを入れる。読み込みを始める前に呼ぶこと。
 * allow が true を返したものだけ許し、ほかはすべて断る（Electron の既定の「許す」を使わない）。
 * openExternal（外部アプリの起動）は onOpenExternal に渡し、ここでは常に断る。
 */
export function installPermissionPolicy(
  ses: PermissionSessionLike,
  allow: (query: PermissionQuery) => boolean = () => false,
  onOpenExternal?: (url: string, origin: string) => void
): void {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.requestingUrl ?? ''
    if (permission === 'openExternal') {
      // 外部アプリへの受け渡しは、確認付きの別の道（onOpenExternal）だけを通す
      if (details.externalURL) onOpenExternal?.(details.externalURL, origin)
      callback(false)
      return
    }
    callback(safeAllow(allow, { permission, origin, request: true, isMainFrame: details.isMainFrame, mediaTypes: details.mediaTypes ?? [], webContents, details }))
  })
  // check の requestingOrigin は file: のページでは「file:///」になるので、フレームの URL（requestingUrl）を先に見る
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === 'openExternal') return false
    return safeAllow(allow, { permission, origin: details.requestingUrl || requestingOrigin || '', request: false, isMainFrame: details.isMainFrame, mediaTypes: details.mediaTypes ?? [], webContents, details })
  })
}

function safeAllow(allow: (query: PermissionQuery) => boolean, query: PermissionQuery): boolean {
  try {
    return allow(query) === true
  } catch {
    // 判定で投げたら断る（許す側に倒さない）
    return false
  }
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    // 読めない URL は断る（想定内）
    return null
  }
}

/**
 * 別のアプリ（OS の URL ハンドラ）へ渡してよいか。http / https / mailto だけ。
 * 認証情報付き（https://user:pass@…）・長すぎるものは断る
 */
export function isAllowedExternalUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length > 2000) return false
  const u = parse(url)
  if (!u) return false
  if (u.protocol === 'mailto:') return u.pathname.length > 0
  return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password
}

/**
 * 内蔵ブラウザのツールバーの「外部ブラウザで開く」で、表示中のページを OS の既定のブラウザへ渡してよいか。
 * http / https だけ（mailto・file:・プレビュー（ade-preview:）・独自スキームは断る）。認証情報付き・長すぎるものも断る。
 * URL は renderer から受け取らず、main が持つ表示中のタブの URL を使う（browser:openExternal）
 */
export function isBrowserPageExternalUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length > 2000) return false
  const u = parse(url)
  if (!u) return false
  return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password
}

/**
 * 内蔵ブラウザの window.open / target=_blank の扱い。
 * - in-app: 同じビューで開く（http / https）
 * - external: 確認のうえ別のアプリへ（mailto）
 * - deny: 何もしない（file: data: javascript: 独自スキームなど）
 */
export function windowOpenAction(url: string): 'in-app' | 'external' | 'deny' {
  // 内蔵ブラウザの中で開くもの（http / https）
  if (isPresetableUrl(url)) return 'in-app'
  return isAllowedExternalUrl(url) ? 'external' : 'deny'
}

/** 手元のマシンのホスト（開発サーバー・題材サイト） */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/**
 * ログインのポップアップ（子ウインドウ）が開いてよい・遷移してよい先。
 * https（認証情報付きは除く）と、手元の開発サーバー（localhost / 127.* の http）と about:blank だけ。
 * file: data: javascript: プレビュー（ade-preview:）・独自スキームは断る
 */
export function isPopupUrlAllowed(url: string): boolean {
  if (url === 'about:blank') return true
  if (typeof url !== 'string' || url.length > 8000) return false
  const u = parse(url)
  if (!u || u.username || u.password || !u.hostname) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && isLoopbackHost(u.hostname)
}

/** setWindowOpenHandler の details の要るところ（Electron の HandlerDetails の一部） */
interface WindowOpenRequest {
  url: string
  /** new-window … window.open に大きさや popup を指定した（ログインのポップアップ）。foreground-tab 等 … 別タブ（target=_blank） */
  disposition?: string
}

/** 同じタブで開く disposition（ページが自分のタブで開くよう求めたもの） */
const SAME_TAB_DISPOSITIONS = new Set(['current-tab', 'save-to-disk'])

/**
 * 内蔵ブラウザのページの window.open / target=_blank の扱い。
 * - popup: ログインのポップアップ（Google でログインなど）。同じセッションの子ウインドウで開き、opener を保つ
 *          （ログインが終わってポップアップが閉じれば、元のページに結果が届く）
 * - tab: 普通の別タブ（target=_blank・大きさを指定しない window.open）。内蔵ブラウザの新しいタブで開く（http / https だけ。opener は渡さない）
 * - in-app / external / deny: windowOpenAction と同じ
 */
export function popupWindowAction(request: WindowOpenRequest): 'popup' | 'tab' | 'in-app' | 'external' | 'deny' {
  if (request.disposition === 'new-window' && isPopupUrlAllowed(request.url)) return 'popup'
  const action = windowOpenAction(request.url)
  if (action === 'in-app' && !SAME_TAB_DISPOSITIONS.has(request.disposition ?? '')) return 'tab'
  return action
}

/**
 * 利用者が URL 欄に入れて開けるもの（renderer から届く遷移）。http / https / プレビュー / プロジェクトのページ / about:blank。
 * javascript: data: や独自スキーム（OS のアプリを起動する）は開かない。
 * file: も開かない（security-7 [2]。renderer が決めた絶対パスで手元の好きなファイルを開かせ、撮影で中身を読ませられた）。
 * プロジェクトの HTML は ade-page://project/<相対パス> で開き、main がプロジェクトの中だけを返す（projectPage.ts）
 */
export function isTypedNavigationAllowed(url: string): boolean {
  if (url === 'about:blank') return true
  const u = parse(url)
  if (!u) return false
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === `${PREVIEW_SCHEME}:` || isProjectPageUrl(url)
}

/**
 * ページが自分で始めた遷移（リンク・location の書き換え）で行ってよい先。
 * http / https / プレビューと about:blank。手元のファイル（file:）へは行かない。
 * プロジェクトのページ（ade-page://）からは、プロジェクトのページの中だけ
 */
export function isPageNavigationAllowed(url: string, currentUrl: string): boolean {
  if (url === 'about:blank') return true
  const u = parse(url)
  if (!u) return false
  // プロジェクトのページからは、プロジェクトのページの中だけ（security-7 [6]。ページのスクリプト・リンクで外へ通信させない。
  // 外のページは利用者が URL 欄に入れて開く）。ほかのページからプロジェクトのページへは行かせない
  if (isProjectPageUrl(currentUrl)) return isProjectPageUrl(url)
  if (u.protocol === `${PROJECT_PAGE_SCHEME}:`) return false
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === `${PREVIEW_SCHEME}:`
}

interface ExternalOpenerDeps {
  /** 利用者に確認する。開くなら true */
  confirm: (request: { url: string; origin: string }) => Promise<boolean>
  open: (url: string) => Promise<void>
  onError?: (err: unknown) => void
}

/**
 * ページが求めた外部アプリの起動を、確認付きで1つずつ通す。
 * 許可リストに無いものは確認も出さずに断る。確認を出している間に来たものは捨てる（連打で確認を積ませない）
 */
export function createExternalOpener(deps: ExternalOpenerDeps): (url: string, origin: string) => Promise<boolean> {
  let pending = false
  return async (url, origin) => {
    if (!isAllowedExternalUrl(url) || pending) return false
    pending = true
    try {
      if (!(await deps.confirm({ url, origin }))) return false
      await deps.open(url)
      return true
    } catch (err) {
      deps.onError?.(err)
      return false
    } finally {
      pending = false
    }
  }
}

/** 確認に出すオリジン（https://example.com）。読めなければそのまま */
export function displayOrigin(url: string): string {
  const u = parse(url)
  if (!u) return url
  return u.origin !== 'null' ? u.origin : `${u.protocol}`
}

/**
 * アプリ自身の画面（renderer・録画ウインドウ）の URL か。
 * roots は「アプリのフォルダの file: URL」と開発サーバーのオリジン。プレビュー（ade-preview:）や、
 * ウインドウへ落とした手元のファイル（アプリの外の file:）は含まない
 */
export function isAppPageUrl(url: string, roots: string[]): boolean {
  const u = parse(url)
  if (!u) return false
  return roots.some((root) => {
    const r = parse(root)
    if (!r) return false
    if (r.protocol === 'file:') {
      const base = r.href.endsWith('/') ? r.href : `${r.href}/`
      return u.protocol === 'file:' && u.href.startsWith(base)
    }
    return u.origin === r.origin
  })
}

/** アプリ自身の画面に許す権限。マイクの音量表示・録画（画面・タブ・マイク）、コピー、動画の全画面 */
export const APP_ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'fullscreen'])

/**
 * 録画ウインドウが内蔵ブラウザのタブを録るときの許可の問い合わせか。
 * タブ録画（chromeMediaSource: 'tab'）は、録られる側の session に「media・機器なし（mediaTypes が空）・
 * 求めたのは録画ウインドウ（file: のアプリの画面）」として届く。ページ自身の getUserMedia は
 * マイクかカメラを必ず含み、オリジンもページのものなので、これには当たらない
 */
export function isTabCaptureRequest(query: Pick<PermissionQuery, 'permission' | 'request' | 'mediaTypes' | 'details'>): boolean {
  const securityOrigin = typeof query.details.securityOrigin === 'string' ? query.details.securityOrigin : ''
  return query.permission === 'media' && query.request && query.mediaTypes.length === 0 && securityOrigin.startsWith('file://')
}

/** ページのコピーを許す、利用者の操作からの時間（security-5 [14]） */
export const PAGE_CLIPBOARD_GRANT_MS = 5_000

/**
 * 内蔵ブラウザのページの「コピー」ボタン（clipboard-sanitized-write）の許可（security-5 [14]）。
 * レビューするページは信用しないので、名前だけでは許さない。内蔵ブラウザのビューを利用者がクリック・キー入力した直後に、
 * そのビューの本体のフレームが、そのときのオリジンのまま求めたときだけ1回許す。
 * ポップアップ（別の webContents）・サブフレーム・別のオリジン・問い合わせ（check）・読み取りは断る
 */
export class PageClipboardGrant {
  private grant: { contents: unknown; origin: string; at: number } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** ビューに本物の入力（OS から届いたクリック・キー）が届いた。main だけが呼ぶ */
  noteGesture(contents: unknown, pageUrl: string): void {
    const origin = parse(pageUrl)?.origin
    this.grant = origin && origin !== 'null' ? { contents, origin, at: this.now() } : null
  }

  allow(query: Pick<PermissionQuery, 'permission' | 'request' | 'isMainFrame' | 'origin' | 'webContents'>): boolean {
    const grant = this.grant
    if (query.permission !== 'clipboard-sanitized-write' || !query.request || query.isMainFrame !== true || !grant) return false
    const age = this.now() - grant.at
    if (query.webContents !== grant.contents || parse(query.origin)?.origin !== grant.origin || !(age >= 0 && age <= PAGE_CLIPBOARD_GRANT_MS)) return false
    this.grant = null
    return true
  }
}

/**
 * 指摘の画面の撮影に内蔵ブラウザのビューを重ねてよいページか（security-7 [2]）。撮った画像は renderer へ返るので、
 * 手元のファイル（file:）などの、利用者が URL 欄から開いたウェブのページでないものは写さない
 */
export function isSnapshotableBrowserUrl(url: string): boolean {
  if (url === '' || url === 'about:blank') return true
  const u = parse(url)
  if (!u) return false
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === `${PREVIEW_SCHEME}:` || isProjectPageUrl(url)
}
