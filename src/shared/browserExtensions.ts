/**
 * 内蔵ブラウザのブラウザ拡張機能（Chrome 拡張）。画面と main の両方から使う、Electron に依存しない決まりだけを置く。
 *
 * - settings.json の browserExtensions は「展開済みの拡張のフォルダ」の一覧（path・enabled）。
 *   読み込みは main（src/main/browserExtensions.ts）が内蔵ブラウザの session にだけ行う。アプリの画面の session には入れない。
 * - manifest.json は信用しない入力として読む（ポップアップのパスは拡張の中の相対パスだけ、名前・版は長さを切る）。
 */

/** 設定の1件。enabled は省略で有効（無効のときだけ false を書く） */
export interface BrowserExtensionEntry {
  /** 展開済みの拡張のフォルダ（manifest.json がある場所）の絶対パス */
  path: string
  enabled?: boolean
}

/** 画面に出す1件の状態（main が読み込みの結果を足したもの） */
export interface BrowserExtensionInfo {
  path: string
  enabled: boolean
  /** 読み込めた拡張の ID（chrome-extension://<id>/）。読み込んでいない・失敗したら null */
  id: string | null
  name: string
  version: string
  /** ツールバーのボタンから開くポップアップがあるか（action.default_popup） */
  hasPopup: boolean
  /** 設定のページ（options_ui.page / options_page）があるか */
  hasOptions: boolean
  /** Chrome から取り込んで Ferret のフォルダに写したもの（消すとき写しも消す） */
  imported: boolean
  /** 読み込めなかった理由（manifest が無い・壊れている・Electron が断った） */
  error?: string
}

/** Chrome などに入っている拡張（取り込みの候補）。key は main が一覧を作るたびに振る */
export interface InstalledBrowserExtension {
  key: string
  /** Chrome・Edge など、どのブラウザのどのプロフィールか（表示用） */
  browser: string
  profile: string
  id: string
  name: string
  version: string
  /** 同じ ID を取り込み済み */
  imported: boolean
}

/** 設定に置ける件数の上限（読み込みは1件ずつなので、多すぎると起動が遅くなる） */
export const MAX_BROWSER_EXTENSIONS = 50

/** ポップアップの大きさ（Chrome と同じ: 最小 25×25、最大 800×600） */
export const POPUP_MIN = { width: 25, height: 25 } as const
export const POPUP_MAX = { width: 800, height: 600 } as const

/** 設定ページ（options）を開くときの大きさ */
export const OPTIONS_SIZE = { width: 720, height: 560 } as const

/** settings.json の browserExtensions を型どおりに直す。絶対パスだけ・重複なし・上限まで。空なら undefined（書かない） */
export function sanitizeBrowserExtensions(raw: unknown): BrowserExtensionEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: BrowserExtensionEntry[] = []
  for (const item of raw) {
    if (out.length >= MAX_BROWSER_EXTENSIONS) break
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    const path = typeof r?.path === 'string' ? r.path.trim() : ''
    if (!path || path.length > 1000 || !isAbsolutePath(path) || path.includes('\0') || seen.has(path)) continue
    seen.add(path)
    out.push(r?.enabled === false ? { path, enabled: false } : { path })
  }
  return out.length ? out : undefined
}

/** POSIX の / 始まりか、Windows のドライブ（C:\）・UNC（\\server\）か */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Chrome の拡張の ID（a〜p の32文字） */
export function isChromeExtensionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-p]{32}$/.test(id)
}

/** 拡張の中の相対パスか（/ 始まり・..・スキーム・\ を含むものは断る）。先頭の ./ は外す */
export function extensionRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim().replace(/^\.\//, '').split(/[?#]/)[0]!
  if (!path || path.length > 300 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  if (path.split('/').some((part) => part === '..' || part === '')) return null
  return path
}

export interface ParsedManifest {
  name: string
  version: string
  manifestVersion: number
  /** action（MV3）・browser_action / page_action（MV2）の default_popup */
  popup: string | null
  /** options_ui.page / options_page */
  options: string | null
  defaultLocale: string | null
  /** テーマ・アプリは拡張としては使えない（取り込みの候補から外す） */
  kind: 'extension' | 'theme' | 'app'
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** manifest.json の中身（JSON.parse 済み）から、使う項目だけを取り出す。拡張でなければ null */
export function parseExtensionManifest(raw: unknown): ParsedManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  const manifestVersion = typeof m.manifest_version === 'number' ? m.manifest_version : 0
  const name = clip(m.name, 200)
  if (!name || (manifestVersion !== 2 && manifestVersion !== 3)) return null
  const popupOf = (key: string): string | null => {
    const action = m[key]
    return action && typeof action === 'object' ? extensionRelativePath((action as Record<string, unknown>).default_popup) : null
  }
  const optionsUi = m.options_ui && typeof m.options_ui === 'object' ? (m.options_ui as Record<string, unknown>).page : undefined
  return {
    name,
    version: clip(m.version, 50),
    manifestVersion,
    popup: manifestVersion === 3 ? popupOf('action') : popupOf('browser_action') ?? popupOf('page_action'),
    options: extensionRelativePath(optionsUi) ?? extensionRelativePath(m.options_page),
    defaultLocale: typeof m.default_locale === 'string' && /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/.test(m.default_locale) ? m.default_locale : null,
    kind: m.theme ? 'theme' : m.app ? 'app' : 'extension'
  }
}

/**
 * 名前の __MSG_xxx__ を _locales/<locale>/messages.json の中身で置き換える（キーは大文字小文字を区別しない）。
 * 見つからなければ元の文字列のまま
 */
export function resolveManifestMessage(value: string, messages: unknown): string {
  const match = /^__MSG_([A-Za-z0-9_@]+)__$/.exec(value)
  if (!match || !messages || typeof messages !== 'object') return value
  const want = match[1]!.toLowerCase()
  for (const [key, entry] of Object.entries(messages as Record<string, unknown>)) {
    if (key.toLowerCase() !== want || !entry || typeof entry !== 'object') continue
    const message = (entry as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200)
  }
  return value
}

/** 版の比べ方（1.10.0 > 1.9.3）。数でない部分は 0 とみなす */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Chrome のプロフィールの拡張のフォルダ（<id>/<版>_0）の中から、いちばん新しい版のフォルダ名 */
export function latestVersionDir(names: string[]): string | null {
  const versions = names.filter((n) => /^\d+(\.\d+)*(_\d+)?$/.test(n))
  if (!versions.length) return null
  return versions.sort((a, b) => compareVersions(b.replace(/_\d+$/, ''), a.replace(/_\d+$/, '')) || (b > a ? 1 : -1))[0]!
}

/** 取り込みの元になる Chromium 系のブラウザの「ユーザーデータ」のフォルダ（OS ごと） */
export function chromiumUserDataDirs(platform: string, home: string, env: Record<string, string | undefined>): Array<{ browser: string; dir: string }> {
  const join = (...parts: string[]) => parts.join(platform === 'win32' ? '\\' : '/')
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return [
      { browser: 'Google Chrome', dir: join(base, 'Google', 'Chrome') },
      { browser: 'Chromium', dir: join(base, 'Chromium') },
      { browser: 'Microsoft Edge', dir: join(base, 'Microsoft Edge') },
      { browser: 'Brave', dir: join(base, 'BraveSoftware', 'Brave-Browser') }
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [
      { browser: 'Google Chrome', dir: join(local, 'Google', 'Chrome', 'User Data') },
      { browser: 'Chromium', dir: join(local, 'Chromium', 'User Data') },
      { browser: 'Microsoft Edge', dir: join(local, 'Microsoft', 'Edge', 'User Data') },
      { browser: 'Brave', dir: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') }
    ]
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  return [
    { browser: 'Google Chrome', dir: join(config, 'google-chrome') },
    { browser: 'Chromium', dir: join(config, 'chromium') },
    { browser: 'Microsoft Edge', dir: join(config, 'microsoft-edge') },
    { browser: 'Brave', dir: join(config, 'BraveSoftware', 'Brave-Browser') }
  ]
}

/** ユーザーデータのフォルダの中で、プロフィールのフォルダか（Default・Profile 1 …） */
export function isChromiumProfileDir(name: string): boolean {
  return name === 'Default' || /^Profile \d{1,3}$/.test(name)
}

/** ポップアップが求めた大きさ（preferred-size-changed）を Chrome と同じ範囲に収める */
export function clampPopupSize(size: { width: number; height: number }, max: { width: number; height: number } = POPUP_MAX): { width: number; height: number } {
  const fit = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo)))
  return { width: fit(size.width, POPUP_MIN.width, max.width), height: fit(size.height, POPUP_MIN.height, max.height) }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * ポップアップを内蔵ブラウザのビューの右上（ツールバーの拡張機能のボタンの下）に置く矩形（ウインドウの中の DIP）。
 * ビューの中に収める。ビューの中に置くのは、録画（ビューのタブ録画の上に重ねる）と見た目の位置を一致させるため
 */
export function placePopup(view: Rect, size: { width: number; height: number }, margin = 8): Rect | null {
  if (view.width <= 0 || view.height <= 0) return null
  const width = Math.min(size.width, Math.max(1, view.width - margin * 2))
  const height = Math.min(size.height, Math.max(1, view.height - margin))
  return { x: Math.round(view.x + view.width - width - margin), y: Math.round(view.y), width: Math.round(width), height: Math.round(height) }
}

/** ウインドウの中の矩形を、ビューの左上を原点にした 0〜1 の割合へ（録画の映像の上の位置） */
export function relativeRect(rect: Rect, view: Rect): Rect | null {
  if (view.width <= 0 || view.height <= 0) return null
  const r = { x: (rect.x - view.x) / view.width, y: (rect.y - view.y) / view.height, width: rect.width / view.width, height: rect.height / view.height }
  if (r.width <= 0 || r.height <= 0 || r.x >= 1 || r.y >= 1 || r.x + r.width <= 0 || r.y + r.height <= 0) return null
  return r
}

/** ポップアップの中から開かれた URL を内蔵ブラウザで開いてよいか（http・https だけ。認証情報付きは断る） */
export function isPopupLinkAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password
  } catch {
    // 読めない URL は開かない（想定内）
    return false
  }
}

/** ポップアップの中の遷移は、その拡張自身のページの中だけ */
export function isOwnExtensionUrl(url: string, extensionId: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'chrome-extension:' && u.host === extensionId
  } catch {
    // 読めない URL は止める（想定内）
    return false
  }
}

/**
 * Chrome ウェブストアの URL（chromewebstore.google.com/detail/<名前>/<ID>、旧 chrome.google.com/webstore/detail/…）か、
 * 拡張の ID そのものから、拡張の ID を取り出す。読めなければ null
 */
export function webStoreExtensionId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (isChromeExtensionId(text)) return text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  const detail = host === 'chromewebstore.google.com' ? segments.indexOf('detail')
    : host === 'chrome.google.com' && segments[0] === 'webstore' ? segments.indexOf('detail') : -1
  if (detail < 0) return null
  const id = segments.slice(detail + 1).find((s) => isChromeExtensionId(s))
  return id ?? null
}

/** ウェブストアからパッケージを取ったあとの行き先として受け付けるホスト（Google の配布の置き場） */
export function isWebStoreDownloadHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'clients2.google.com' || h === 'clients2.googleusercontent.com' || h.endsWith('.gvt1.com') || h === 'edgedl.me.gvt1.com'
}
