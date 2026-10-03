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
import { isUserFacingError } from './errors'

/**
 * 送り先。公開してよい値（OSS のアプリに埋め込む前提）。
 * フォークした人は MOVIE_ADE_SENTRY_DSN で自分の Sentry に向けられ、空にすれば送らない。
 */
export const DEFAULT_SENTRY_DSN =
  'https://716da12f9b6378ca3e3fd1cf8206846a@o4511317909569536.ingest.us.sentry.io/4512189930602496'

/**
 * release の名前。配布版は `movie-ade@<version>`（`sentry` CLI でソースマップを上げるときも同じ名前）。
 * dev 起動は `movie-ade@<version>+<git の短いハッシュ>`（取れなければ `+dev`）。どのコミットで出たかを分ける。
 */
export function sentryRelease(version: string, dev?: { gitHash?: string | null }): string {
  if (!dev) return `movie-ade@${version}`
  const hash = dev.gitHash && /^[0-9a-f]{4,40}$/i.test(dev.gitHash.trim()) ? dev.gitHash.trim() : 'dev'
  return `movie-ade@${version}+${hash}`
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
  /** E2E（ADE_E2E=1） */
  e2e: boolean
  /**
   * 送信の確認用（MOVIE_ADE_SENTRY_FORCE=1）。E2E の起動（ウインドウを出さず、OS の許可のダイアログも出さない）でも送る。
   * 単体テストと設定 OFF には勝たない
   */
  forced?: boolean
  /** 単体テスト（VITEST） */
  unitTest: boolean
  /** 設定の「クラッシュレポートを送る」 */
  enabled: boolean
  dsn: string | null
}

/**
 * 配布版と dev 起動の両方で送る（dev のエラーも集めて直すため）。
 * E2E・単体テスト・設定 OFF・DSN が空なら送らない。
 */
export function shouldSendCrashReports(c: CrashReportConditions): boolean {
  return Boolean(c.dsn) && c.enabled && (!c.e2e || c.forced === true) && !c.unitTest
}

export interface TelemetryProfile {
  environment: 'production' | 'development'
  /** JS の例外を送る割合（ネイティブのクラッシュは常に全部） */
  sampleRate: number
  /** 1回の起動で送る数の上限（エラー・クラッシュ） */
  maxEventsPerRun: number
  /** 1回の起動で送る warning（握りつぶしていた失敗・性能の異常）の上限。クラッシュの枠を食わないよう別に数える */
  maxWarningsPerRun: number
}

/**
 * 環境ごとの送り方。配布版は利用者が多いので間引き、dev は開発者の手元だけなので全部送る。
 * どちらも同じエラーは1回の起動で1度だけ（createEventLimiter）。
 */
export function telemetryProfile(packaged: boolean): TelemetryProfile {
  return packaged
    ? { environment: 'production', sampleRate: JS_ERROR_SAMPLE_RATE, maxEventsPerRun: MAX_EVENTS_PER_RUN, maxWarningsPerRun: 5 }
    : { environment: 'development', sampleRate: 1, maxEventsPerRun: MAX_DEV_EVENTS_PER_RUN, maxWarningsPerRun: 30 }
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
export function scrubString(input: string, ctx: ScrubContext = {}, max = MAX_STRING_LENGTH): string {
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
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s
}

/** スタックのファイル名は長さで切らない（ソースマップの照合に要る） */
/** Sentry が付ける ID（32桁の16進）。秘密の形に見えても触らない */
const ID_KEYS = new Set(['event_id', 'trace_id', 'span_id', 'parent_span_id', 'sid', 'replay_id', 'profile_id'])

const UNTRUNCATED_KEYS = new Set(['filename', 'abs_path', 'module', 'debug_id', 'code_file', 'debug_file'])
/** 長くてよい文字列（React のコンポーネントの階層）。伏せる処理は同じ */
const LONG_TEXT_KEYS: Record<string, number> = { componentStack: 2000 }

function scrubDeep(value: unknown, ctx: ScrubContext, key = '', depth = 0): unknown {
  if (depth > 12) return undefined
  if (typeof value === 'string') {
    if (ID_KEYS.has(key)) return value
    return UNTRUNCATED_KEYS.has(key) ? scrubPath(value, ctx) : scrubString(value, ctx, LONG_TEXT_KEYS[key])
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
 * 残してよい breadcrumb の種類。アプリやウィンドウの出来事（electron）、子プロセスの終了、
 * 起動の失敗（startup。console.error の `[startup]` だけを拾う）。
 * ほかの console・fetch・クリック・画面遷移は、ターミナルの出力やページの URL・要素の文言を含みうるので落とす。
 */
const BREADCRUMB_CATEGORIES = new Set(['electron', 'child-process', 'startup', 'flow'])
/** flow（主要な流れの区切り。src/shared/report.ts）の data に残してよい値：数と、短い識別子（agent 名・種類）だけ */
const FLOW_VALUE = /^[A-Za-z0-9_.:-]{1,40}$/
export const MAX_BREADCRUMBS = 30

type Breadcrumb = { category?: string; message?: string; data?: { [key: string]: unknown } }

export function scrubBreadcrumb<T extends Breadcrumb>(crumb: T, ctx: ScrubContext = {}): T | null {
  if (!crumb.category || !BREADCRUMB_CATEGORIES.has(crumb.category)) return null
  // data には URL やウィンドウのタイトルが入るので、子プロセスの終了の情報と、flow の短い識別子以外は持たない
  const data = crumb.category === 'child-process' && crumb.data
    ? pick(crumb.data, ['type', 'reason', 'exitCode', 'name'])
    : crumb.category === 'flow' && crumb.data
      ? flowData(crumb.data)
      : undefined
  const out: Breadcrumb = { ...crumb, data }
  if (!data) delete out.data
  if (typeof out.message === 'string') out.message = scrubString(out.message, ctx)
  return scrubDeep(out, ctx) as T
}

function flowData(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!FLOW_VALUE.test(k)) continue
    if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && FLOW_VALUE.test(v))) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

/** 残してよい contexts（OS・端末・アプリ・実行環境の版）。それ以外は落とす */
const ALLOWED_CONTEXTS = new Set(['os', 'device', 'app', 'runtime', 'electron', 'chrome', 'node', 'gpu', 'culture', 'trace', 'react'])

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
/** dev 起動の上限。開発者の手元だけなので多めに集める（重複の抑止は同じ） */
export const MAX_DEV_EVENTS_PER_RUN = 50

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

/** ErrorBoundary で捕まえた描画のエラーに付けるタグと文脈。componentStack はコンポーネントの階層 */
export function renderErrorCapture(boundary: string, componentStack?: string | null): {
  tags: Record<string, string>
  contexts: { react: { componentStack: string } }
} {
  return {
    tags: { kind: 'render-error', 'error.boundary': boundary },
    contexts: { react: { componentStack: (componentStack ?? '').trim() } }
  }
}

/**
 * did-fail-load を送るか。アプリ自身の画面（main の renderer・録画ウインドウ・プレビュー）の読み込み失敗だけを送る。
 * 内蔵ブラウザで開いた利用者のページ（別のセッション）は、相手のサーバーが止まっているなど利用者側の失敗が
 * 普通に起きるので送らない。-3（ERR_ABORTED）は次の読み込みで前の読み込みが止まっただけなので送らない。
 */

export function shouldReportLoadFailure(f: { ownPage: boolean; errorCode: number; isMainFrame: boolean }): boolean {
  if (!f.isMainFrame || f.errorCode === -3) return false
  return f.ownPage
}

/** render-process-gone / child-process-gone を送るか。正常終了と、利用者が止めた（killed）ものは送らない */
export function shouldReportProcessGone(reason: string): boolean {
  return reason !== 'clean-exit' && reason !== 'killed'
}

/** 確認用（MOVIE_ADE_SENTRY_TEST）。`1`/`all` は全部、`main,renderer` のように選べる */
export const SENTRY_TEST_KINDS = ['main', 'renderer', 'boundary', 'ipc', 'handled'] as const
export type SentryTestKind = (typeof SENTRY_TEST_KINDS)[number]

export function parseSentryTestKinds(raw: string | undefined): SentryTestKind[] {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v || v === '0') return []
  if (v === '1' || v === 'all') return [...SENTRY_TEST_KINDS]
  return SENTRY_TEST_KINDS.filter((k) => v.split(/[\s,]+/).includes(k))
}

/**
 * IPC のハンドラを包み、投げた例外を `kind: ipc` と チャネル名のタグ付きで送る。
 * 利用者に見せるための想定内のエラー（UserFacingError）は送らない。
 * 例外はどちらもそのまま投げ直す（renderer 側の扱いは変えない）。送る処理（report）は main が渡す。
 */
export function wrapIpcHandler<A extends unknown[], R>(
  channel: string,
  handler: (...args: A) => R | Promise<R>,
  report: (err: unknown, tags: Record<string, string>) => void
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (err) {
      if (!isUserFacingError(err)) report(err, { kind: 'ipc', 'ipc.channel': channel })
      throw err
    }
  }
}

/** 性能の異常の閾値。起動して操作できるまで（目標 2s）と、main のイベントループの停止 */
export const SLOW_STARTUP_MS = 5000
export const EVENT_LOOP_BLOCK_MS = 1000
/** 同じ種類の性能の異常を続けて送らない間隔 */
export const ANOMALY_COOLDOWN_MS = 10 * 60 * 1000

/** 性能の異常を、種類ごとに一定時間に1度だけ通す。now はテストで差し替える */
export function createAnomalyGate(cooldownMs = ANOMALY_COOLDOWN_MS, now: () => number = Date.now): (key: string) => boolean {
  const last = new Map<string, number>()
  return (key) => {
    const t = now()
    const prev = last.get(key)
    if (prev !== undefined && t - prev < cooldownMs) return false
    last.set(key, t)
    return true
  }
}

/** 停止の長さを粗い区分にする（タグの値が増えすぎないように） */
export function durationBucket(ms: number): string {
  if (ms < 2000) return '1-2s'
  if (ms < 5000) return '2-5s'
  if (ms < 10000) return '5-10s'
  return '10s+'
}
