/**
 * ほかのブラウザ（Chrome・Edge・Safari・Firefox など）からの取り込み。画面に依存しない純粋な関数だけを置く（単体テストの対象）。
 *
 * - パスワード: 利用者がブラウザの公式の機能で書き出した「パスワードの CSV」を読む。
 *   ブラウザのプロフィールの暗号化された保存領域（Keychain・DPAPI など）は読まない
 * - 履歴: Chromium 系の History・Safari の History.db（SQLite）から読んだ行を、URL 欄の候補の形にそろえる
 *
 * パスワードの平文は main の中だけで扱う。renderer へはオリジンとユーザー名だけを渡す（src/main/browserImport/passwords.ts）。
 */

/** CSV から読んだ1件。password は main の外へ出さない */
export interface ImportedLogin {
  /** スキーム＋ホスト＋ポート（URL.origin の形） */
  origin: string
  username: string
  password: string
}

/** renderer へ渡す、保存した資格情報の1件（パスワードは含めない） */
export interface SavedLoginAccount {
  id: string
  username: string
  /** 同じサイトの別のサブドメインで保存したもの（login.example.com で保存し example.com で使うなど）。そのホスト名。同じオリジンなら無い */
  site?: string
}

/** 書き出した CSV の元のブラウザ（見出しの形で見分ける）。取り込み直すと、同じ元から前に取り込んだものを置き換える */
export type PasswordCsvSource = 'chromium' | 'safari' | 'firefox' | 'other'

/** ダウンロード・デスクトップで見つけた、パスワードの書き出しの CSV（画面へは key だけを返してもらう） */
export interface PasswordExportFile {
  key: string
  name: string
  modifiedAt: number
}

/** いま内蔵ブラウザで開いているページに使える資格情報 */
export interface PageLogins {
  /** ページのオリジン。http / https でなければ空 */
  origin: string
  /** ページにパスワードの欄があるか（保存した資格情報があるときだけ調べる） */
  hasPasswordField: boolean
  accounts: SavedLoginAccount[]
}

/** 取り込んだ履歴の1件（全プロジェクト共通） */
export interface ImportedHistoryEntry {
  url: string
  title: string
  /** 最終訪問（UNIX 時刻のミリ秒） */
  lastVisit: number
}

/** 履歴を取り込める元（main が見つけたもの）。画面へは key だけを返してもらう */
export interface HistorySourceInfo {
  key: string
  browser: string
  /** Chromium 系のプロフィールのフォルダ名（Default・Profile 1 …）。Safari は空 */
  profile: string
  kind: 'chromium' | 'safari'
}

/** 設定のページの「ブラウザから取り込む」の表示 */
export interface BrowserImportStatus {
  passwords: {
    count: number
    /** 暗号化して保存しているか。false なら、取り込んだものはこの起動の間だけ持つ */
    persisted: boolean
  }
  history: { count: number }
}

/** 取り込みの上限。巨大なファイル・行で main が詰まらないように */
export const BROWSER_IMPORT_LIMITS = {
  /** パスワードの CSV の大きさ */
  csvBytes: 20 * 1024 * 1024,
  /** パスワードの件数 */
  logins: 20_000,
  usernameChars: 512,
  passwordChars: 1024,
  /** 1つの元から読む履歴の行数 */
  historyRowsPerSource: 20_000,
  /** 取り込んだ履歴として持つ件数 */
  historyEntries: 30_000,
  urlChars: 2048,
  titleChars: 300
} as const

/**
 * CSV を行と列に分ける（RFC 4180。"" で囲んだ中の , ・改行・"" を扱う）。BOM は落とし、空の行は除く
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((cell) => cell !== '')) rows.push(row)
  return rows
}

/** 見出しの名前の揺れ（Chrome / Edge: name,url,username,password,note、Safari: Title,URL,Username,Password,Notes,OTPAuth、Firefox: url,username,password,…） */
const HEADER_ALIASES = {
  url: ['url', 'login_uri', 'website', 'origin'],
  username: ['username', 'login_username', 'user name', 'login'],
  password: ['password', 'login_password']
} as const

/**
 * ページの URL から、照合に使うオリジンを作る。http / https だけ。スキームが無ければ https とみなす（example.com）。
 * 読めなければ null
 */
export function loginOrigin(url: string): string | null {
  const text = url.trim()
  if (!text || text.length > BROWSER_IMPORT_LIMITS.urlChars) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return parsed.origin
}

/**
 * パスワードの CSV を読む。見出しに URL とパスワードの列が無ければ null（パスワードの CSV ではない）。
 * http / https でない行（android:// など）・パスワードが空の行・長すぎる行は飛ばして数える。
 * 同じオリジン＋ユーザー名は後の行で上書きする
 */
export function parsePasswordCsv(text: string): { logins: ImportedLogin[]; skipped: number; source: PasswordCsvSource } | null {
  const rows = parseCsv(text)
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase())
  if (!header) return null
  const source: PasswordCsvSource = header.includes('httprealm') || header.includes('formactionorigin') ? 'firefox'
    : header.includes('otpauth') || (header.includes('title') && header.includes('notes')) ? 'safari'
      : header.includes('name') && header.includes('note') ? 'chromium'
        : 'other'
  const column = (names: readonly string[]) => header.findIndex((name) => names.includes(name))
  const urlAt = column(HEADER_ALIASES.url)
  const usernameAt = column(HEADER_ALIASES.username)
  const passwordAt = column(HEADER_ALIASES.password)
  if (urlAt < 0 || passwordAt < 0) return null
  const byKey = new Map<string, ImportedLogin>()
  let skipped = 0
  for (const row of rows.slice(1)) {
    const origin = loginOrigin(row[urlAt] ?? '')
    const username = usernameAt >= 0 ? (row[usernameAt] ?? '').trim() : ''
    const password = row[passwordAt] ?? ''
    if (!origin || !password || password.length > BROWSER_IMPORT_LIMITS.passwordChars || username.length > BROWSER_IMPORT_LIMITS.usernameChars) {
      skipped++
      continue
    }
    const key = `${origin}\n${username}`
    if (!byKey.has(key) && byKey.size >= BROWSER_IMPORT_LIMITS.logins) {
      skipped++
      continue
    }
    byKey.delete(key)
    byKey.set(key, { origin, username, password })
  }
  return { logins: [...byKey.values()], skipped, source }
}

/** 先頭の www. だけを外す（www の有無は同じサイトとみなす） */
function withoutWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname
}

/**
 * 保存した資格情報のオリジンが、ページのオリジンに使えるか。
 * スキーム・ポートは完全に一致、ホストは完全に一致か www. の有無だけの違い。サブドメイン（login.example.com と example.com）は別とみなす
 */
export function originMatches(savedOrigin: string, pageUrl: string): boolean {
  const page = loginOrigin(pageUrl)
  if (!page || !/^https?:\/\//.test(pageUrl.trim())) return false
  let saved: URL
  let current: URL
  try {
    saved = new URL(savedOrigin)
    current = new URL(page)
  } catch {
    return false
  }
  if (saved.protocol !== current.protocol || saved.port !== current.port) return false
  return saved.hostname === current.hostname || withoutWww(saved.hostname) === withoutWww(current.hostname)
}

/**
 * 2段の公開ドメイン（co.jp・com.au など）。ここに無いものは最後の2つのラベルをサイトとする（Chrome の公開サフィックスの近似）
 */
const SECOND_LEVEL = /^(?:co|ne|or|ac|go|ed|gr|lg|ad|com|net|org|gov|edu|ac|mil)\.[a-z]{2}$/
/**
 * 誰でもサブドメインを作れる共有の置き場。ここでは別のサブドメインを同じサイトとみなさない（他人のページに出さない）
 */
const SHARED_HOSTS = /(?:^|\.)(?:github\.io|gitlab\.io|vercel\.app|netlify\.app|pages\.dev|workers\.dev|herokuapp\.com|web\.app|firebaseapp\.com|cloudfront\.net|amazonaws\.com|azurewebsites\.net|appspot\.com|onrender\.com|fly\.dev|ngrok\.io|ngrok-free\.app|blogspot\.com|wordpress\.com|myshopify\.com|glitch\.me|repl\.co|run\.app|trycloudflare\.com)$/

/** ホスト名のサイト（example.com・example.co.jp）。IP・localhost・共有の置き場・ラベルが1つなら null */
export function siteOf(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.localhost') || SHARED_HOSTS.test(host)) return null
  const labels = host.split('.')
  const lastTwo = labels.slice(-2).join('.')
  const take = SECOND_LEVEL.test(lastTwo) ? 3 : 2
  return labels.length >= take ? labels.slice(-take).join('.') : null
}

/**
 * 保存した資格情報をそのページに使えるか。
 * - exact: 同じオリジン（www の有無は同じ）。http で保存したものを同じホストの https のページで使うのも exact（Chrome と同じ格上げ）
 * - site: 同じサイトの別のサブドメイン（Chrome の公開サフィックスでの照合と同じく、利用者が選んだときだけ入れる）。
 *   スキームは同じか http→https。ポートは同じ。共有の置き場（github.io など）は使わない
 * 使えなければ null
 */
export function loginMatch(savedOrigin: string, pageUrl: string): 'exact' | 'site' | null {
  if (originMatches(savedOrigin, pageUrl)) return 'exact'
  const page = loginOrigin(pageUrl)
  if (!page || !/^https?:\/\//.test(pageUrl.trim())) return null
  let saved: URL
  let current: URL
  try {
    saved = new URL(savedOrigin)
    current = new URL(page)
  } catch {
    return null
  }
  const upgrade = saved.protocol === 'http:' && current.protocol === 'https:' && !saved.port && !current.port
  if (saved.protocol !== current.protocol && !upgrade) return null
  if (!upgrade && saved.port !== current.port) return null
  if (withoutWww(saved.hostname) === withoutWww(current.hostname)) return upgrade ? 'exact' : null
  const site = siteOf(saved.hostname)
  return site && site === siteOf(current.hostname) ? 'site' : null
}

/** パスワードの書き出しらしいファイル名（Chrome・Edge・Brave・Safari・Firefox の既定の名前と、各言語の「パスワード」） */
export function isPasswordExportName(name: string): boolean {
  return /\.csv$/i.test(name) && /(passwords?|パスワード|密码|密碼|비밀번호|contraseñas|mots de passe|passwörter|kennwörter|senhas|password|пароли|mật khẩu|kata sandi|पासवर्ड|logins)/i.test(name)
}

/** Chromium の時刻（1601-01-01 からのミリ秒。SQL でマイクロ秒を 1000 で割ったもの）を UNIX 時刻のミリ秒へ */
export function chromiumMsToUnixMs(msSince1601: number): number {
  return msSince1601 - 11_644_473_600_000
}

/** Safari の時刻（2001-01-01 からの秒）を UNIX 時刻のミリ秒へ */
export function safariSecondsToUnixMs(secondsSince2001: number): number {
  return Math.round((secondsSince2001 + 978_307_200) * 1000)
}

/** DB の1行を履歴の1件にそろえる。http / https でない・長すぎる・時刻の読めない行は null */
export function toHistoryEntry(row: { url: unknown; title: unknown; lastVisit: number }): ImportedHistoryEntry | null {
  if (typeof row.url !== 'string' || row.url.length > BROWSER_IMPORT_LIMITS.urlChars) return null
  if (!/^https?:\/\//i.test(row.url)) return null
  try {
    new URL(row.url)
  } catch {
    return null
  }
  if (!Number.isFinite(row.lastVisit) || row.lastVisit <= 0) return null
  const title = typeof row.title === 'string' ? row.title.replace(/\s+/g, ' ').trim().slice(0, BROWSER_IMPORT_LIMITS.titleChars) : ''
  return { url: row.url, title, lastVisit: Math.round(row.lastVisit) }
}

/** 取り込んだ履歴を合わせる。同じ URL は新しい訪問・空でないタイトルを残し、新しい順に上限まで */
export function mergeHistory(existing: readonly ImportedHistoryEntry[], incoming: readonly ImportedHistoryEntry[], max: number = BROWSER_IMPORT_LIMITS.historyEntries): ImportedHistoryEntry[] {
  const byUrl = new Map<string, ImportedHistoryEntry>()
  for (const entry of [...existing, ...incoming]) {
    const prev = byUrl.get(entry.url)
    if (!prev) {
      byUrl.set(entry.url, entry)
      continue
    }
    const newer = entry.lastVisit >= prev.lastVisit ? entry : prev
    byUrl.set(entry.url, { ...newer, title: newer.title || (newer === entry ? prev.title : entry.title) })
  }
  return [...byUrl.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, max)
}

/** 保存したファイルの中身を確かめて読む（壊れた行は捨てる） */
export function sanitizeHistory(raw: unknown): ImportedHistoryEntry[] {
  const list = Array.isArray(raw) ? raw : (raw as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) return []
  const entries: ImportedHistoryEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = toHistoryEntry({ url: (item as Record<string, unknown>).url, title: (item as Record<string, unknown>).title, lastVisit: Number((item as Record<string, unknown>).lastVisit) })
    if (entry) entries.push(entry)
  }
  return mergeHistory([], entries)
}

/**
 * URL 欄の入力に合う取り込んだ履歴。空白で区切った語をすべて URL かタイトルに含むもの（大文字小文字は見ない）。
 * ホスト名が入力で始まるものを先に、あとは新しい順
 */
export function suggestHistory(entries: readonly ImportedHistoryEntry[], query: string, limit = 8): ImportedHistoryEntry[] {
  const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const first = words[0]!.replace(/^https?:\/\//, '').replace(/^www\./, '')
  const hostStarts = (url: string): boolean => {
    try {
      return withoutWww(new URL(url).hostname).startsWith(first)
    } catch {
      return false
    }
  }
  const matched = entries.filter((entry) => {
    const haystack = `${entry.url} ${entry.title}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
  const ranked = matched.map((entry) => ({ entry, host: hostStarts(entry.url) }))
  ranked.sort((a, b) => Number(b.host) - Number(a.host) || b.entry.lastVisit - a.entry.lastVisit)
  return ranked.slice(0, limit).map((r) => r.entry)
}
