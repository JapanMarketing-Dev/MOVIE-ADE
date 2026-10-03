/**
 * クラッシュレポート（Sentry）の送る条件と、送る前に個人の情報を落とす処理。
 *
 * main（初期化と beforeSend）と単体テストから使う。renderer のイベントと minidump も
 * main の beforeSend を通ってから送られるので、ここで落とせば全部の経路に効く。
 * Sentry の型には依存させず、イベントはただのオブジェクトとして扱う。
 *
 * 送るのは「アプリが落ちた・例外が出た」という事実と、その場所（スタック）と、
 * OS・CPU・Electron の版だけ。画面の中身（URL・ターミナル・文字起こし・指摘）は送らない。
 */

/**
 * 送り先。公開してよい値（OSS のアプリに埋め込む前提）。
 * フォークした人は MOVIE_ADE_SENTRY_DSN で自分の Sentry に向けられ、空にすれば送らない。
 */
export const DEFAULT_SENTRY_DSN =
  'https://716da12f9b6378ca3e3fd1cf8206846a@o4511317909569536.ingest.us.sentry.io/4512189930602496'

/** release の名前（`sentry` CLI でソースマップを上げるときも同じ名前を使う） */
export function sentryRelease(version: string): string {
  return `movie-ade@${version}`
}

/** 環境変数があればそれを使う（空文字＝送らない）。無ければ既定の DSN */
export function resolveSentryDsn(env: Record<string, string | undefined>): string | null {
  const raw = env.MOVIE_ADE_SENTRY_DSN
  if (raw === undefined) return DEFAULT_SENTRY_DSN
  const v = raw.trim()
  return v ? v : null
}

/** 設定の値。未設定は ON（既定 ON、設定でいつでも OFF） */
export function crashReportsEnabled(settings: { crashReports?: boolean }): boolean {
  return settings.crashReports !== false
}

export interface CrashReportConditions {
  /** app.isPackaged */
  packaged: boolean
  /** 配布版と同じに扱う確認用（MOVIE_ADE_SENTRY_FORCE=1）。dev 起動で実際に1件送るときだけ使う */
  forced: boolean
  /** E2E（ADE_E2E=1） */
  e2e: boolean
  /** 設定の「クラッシュレポートを送る」 */
  enabled: boolean
  dsn: string | null
}

/** 配布版だけで送る。dev 起動・E2E・設定 OFF・DSN が空なら送らない */
export function shouldSendCrashReports(c: CrashReportConditions): boolean {
  if (!c.dsn || !c.enabled || c.e2e) return false
  return c.packaged || c.forced
}

/** 送る前に伏せる材料。プロジェクトのフォルダは設定から渡す */
export interface ScrubContext {
  homeDir?: string
  projectPaths?: readonly string[]
}

/** 例外のメッセージなど、1つの文字列の上限。長い文には画面の中身が入りやすい */
export const MAX_STRING_LENGTH = 300

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** http(s)/ws(s) の URL。内蔵ブラウザで開いたページ・API の接続先。app:// と file:// はスタックに要るので残す */
const WEB_URL = /\b(?:https?|wss?):\/\/[^\s"'<>()]+/gi
/** ホームの下の利用者名（/Users/<name>、/home/<name>、C:\Users\<name>）。区切りは / と \ の両方 */
const HOME_UNIX = /(^|[\s"'(=:]|file:\/\/)\/(?:Users|home)\/[^/\\\s"']+/g
const HOME_WIN = /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"']+/gi
/** よく使われる API キーの形（redact.ts の looksSecret と同じ前置き）、Bearer、JWT、長い16進 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}/g,
  /\bxox[bpsar]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[0-9a-f]{32,}\b/gi
]

/** 文字列1つから個人の情報を落とす */
export function scrubString(input: string, ctx: ScrubContext = {}): string {
  let s = input
  // プロジェクトのフォルダはホームより先に（ホームの下にあることが多い）
  for (const p of ctx.projectPaths ?? []) {
    if (p && p.length > 1) s = s.replace(new RegExp(escapeRegExp(p), 'g'), '<project>')
  }
  if (ctx.homeDir && ctx.homeDir.length > 1) s = s.replace(new RegExp(escapeRegExp(ctx.homeDir), 'g'), '~')
  s = s.replace(HOME_UNIX, (_m, lead: string) => `${lead}~`)
  s = s.replace(HOME_WIN, '~')
  s = s.replace(WEB_URL, '<url>')
  s = s.replace(EMAIL, '<email>')
  for (const re of SECRET_PATTERNS) s = s.replace(re, '<secret>')
  if (s.length > MAX_STRING_LENGTH) s = `${s.slice(0, MAX_STRING_LENGTH)}…`
  return s
}

/** スタックのファイル名は長さで切らない（ソースマップの照合に要る） */
/** Sentry が付ける ID（32桁の16進）。秘密の形に見えても触らない */
const ID_KEYS = new Set(['event_id', 'trace_id', 'span_id', 'parent_span_id', 'sid', 'replay_id', 'profile_id'])

const UNTRUNCATED_KEYS = new Set(['filename', 'abs_path', 'module', 'debug_id', 'code_file', 'debug_file'])

function scrubDeep(value: unknown, ctx: ScrubContext, key = '', depth = 0): unknown {
  if (depth > 12) return undefined
  if (typeof value === 'string') {
    if (ID_KEYS.has(key)) return value
    return UNTRUNCATED_KEYS.has(key) ? scrubPath(value, ctx) : scrubString(value, ctx)
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, ctx, key, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, ctx, k, depth + 1)
    return out
  }
  return value
}

/** スタックのファイル名。伏せるのはホームとプロジェクトのパスだけで、長さでは切らない */
function scrubPath(value: string, ctx: ScrubContext): string {
  let s = value
  for (const p of ctx.projectPaths ?? []) if (p && p.length > 1) s = s.split(p).join('<project>')
  if (ctx.homeDir && ctx.homeDir.length > 1) s = s.split(ctx.homeDir).join('~')
  return s.replace(HOME_UNIX, (_m, lead: string) => `${lead}~`).replace(HOME_WIN, '~')
}

/**
 * 残してよい breadcrumb の種類。アプリやウィンドウの出来事（electron）と子プロセスの終了だけ。
 * console・fetch・クリック・画面遷移は、ターミナルの出力やページの URL・要素の文言を含みうるので落とす。
 */
const BREADCRUMB_CATEGORIES = new Set(['electron', 'child-process'])
export const MAX_BREADCRUMBS = 30

type Breadcrumb = { category?: string; message?: string; data?: { [key: string]: unknown } }

export function scrubBreadcrumb<T extends Breadcrumb>(crumb: T, ctx: ScrubContext = {}): T | null {
  if (!crumb.category || !BREADCRUMB_CATEGORIES.has(crumb.category)) return null
  // data には URL やウィンドウのタイトルが入るので、子プロセスの終了の情報以外は持たない
  const data = crumb.category === 'child-process' && crumb.data
    ? pick(crumb.data, ['type', 'reason', 'exitCode', 'name'])
    : undefined
  const out: Breadcrumb = { ...crumb, data }
  if (!data) delete out.data
  if (typeof out.message === 'string') out.message = scrubString(out.message, ctx)
  return scrubDeep(out, ctx) as T
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

/** 残してよい contexts（OS・端末・アプリ・実行環境の版）。それ以外は落とす */
const ALLOWED_CONTEXTS = new Set(['os', 'device', 'app', 'runtime', 'electron', 'chrome', 'node', 'gpu', 'culture', 'trace'])

type EventLike = {
  breadcrumbs?: Breadcrumb[]
  contexts?: object
  exception?: unknown
  message?: unknown
}

/**
 * Sentry へ送る前のイベントから個人の情報を落とす。
 * user・request・extra・server_name は丸ごと持たない。残る文字列は全部 scrubString を通す。
 */
export function scrubEvent<T extends EventLike>(event: T, ctx: ScrubContext = {}): T {
  const copy = { ...event } as EventLike & Record<string, unknown>
  delete copy.user
  delete copy.request
  delete copy.extra
  delete copy.server_name
  if (copy.contexts) {
    const contexts: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(copy.contexts)) {
      if (!ALLOWED_CONTEXTS.has(k) || !v || typeof v !== 'object') continue
      // 端末名・機種の ID・起動した時刻など、端末の識別につながる項目は落とす
      const { name: _n, model_id: _m, boot_time: _b, ...rest } = v as Record<string, unknown>
      contexts[k] = k === 'device' ? rest : v
    }
    copy.contexts = contexts
  }
  if (copy.breadcrumbs) {
    copy.breadcrumbs = copy.breadcrumbs
      .map((b) => scrubBreadcrumb(b, ctx))
      .filter((b): b is Breadcrumb => b !== null)
      .slice(-MAX_BREADCRUMBS)
  }
  return scrubDeep(copy, ctx) as T
}

/**
 * 同じエラーを何度も送らないための鍵。例外の種類・メッセージ・一番上のフレームで決める。
 * 1回の起動で同じ鍵は1度だけ送る（無料の上限の中に収める）。
 */
export function eventFingerprint(event: EventLike): string {
  const values = (event.exception as { values?: Array<Record<string, unknown>> } | undefined)?.values ?? []
  const last = values[values.length - 1]
  if (!last) return `msg:${String(event.message ?? '')}`
  const frames = ((last.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined)?.frames ?? [])
  const top = frames[frames.length - 1]
  return [last.type, last.value, top?.filename, top?.function, top?.lineno].map((v) => String(v ?? '')).join('|')
}

/** 1回の起動で送る数の上限。暴走しているときに無料の枠を使い切らない */
export const MAX_EVENTS_PER_RUN = 10

/** 起動ごとの送信の抑え（重複と上限）。テストのため状態を外に持てる形にする */
export function createEventLimiter(max = MAX_EVENTS_PER_RUN): (event: EventLike) => boolean {
  const seen = new Set<string>()
  let sent = 0
  return (event) => {
    if (sent >= max) return false
    const key = eventFingerprint(event)
    if (seen.has(key)) return false
    seen.add(key)
    sent += 1
    return true
  }
}

/**
 * JS の例外は半分だけ送る（同じ不具合は多くの人で起きるので、半分でも気づける）。
 * ネイティブのクラッシュ（minidump）は数が少なく重いので、全部送る。
 */
export const JS_ERROR_SAMPLE_RATE = 0.5

export function sampleEvent(isNativeCrash: boolean, random: () => number = Math.random, rate = JS_ERROR_SAMPLE_RATE): boolean {
  return isNativeCrash || random() < rate
}
