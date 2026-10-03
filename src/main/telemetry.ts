import { app, crashReporter, session, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Sentry from '@sentry/electron/main'
import {
  crashReportsEnabled,
  createEventLimiter,
  parseSentryTestKinds,
  resolveSentryDsn,
  sampleEvent,
  scrubBreadcrumb,
  scrubEvent,
  sentryRelease,
  shouldReportLoadFailure,
  shouldReportProcessGone,
  shouldSendCrashReports,
  telemetryProfile,
  createAnomalyGate,
  durationBucket,
  EVENT_LOOP_BLOCK_MS,
  type ScrubContext,
  type SentryTestKind
} from '@shared/telemetry'
import { flow, reportAnomaly, reportHandled, setReporter } from '@shared/report'
import { version } from '../../package.json'
import { currentSettings } from './settings'
import { remapDevFrames } from './telemetrySourceMaps'

/**
 * クラッシュレポート（Sentry）。設定の「クラッシュレポートを送る」と src/shared/telemetry.ts を参照。
 *
 * - 配布版（production）と dev 起動（development）の両方で送る。E2E・単体テストでは初期化しない。
 *   配布版は JS の例外を半分・1回の起動で10件まで、dev は全部・50件まで。同じエラーはどちらも1度だけ。
 * - 起動時に設定が OFF なら初期化しない。起動後に OFF にしたら beforeSend で全部捨てる
 *   （ON に戻したときは次の起動から送る。minidump の受け口は ready の前にしか入れられないため）。
 * - パフォーマンスの計測・セッション・リプレイ・スクリーンショットは使わない。
 * - 未処理の例外のほかに、レンダラー・子プロセスの異常終了、ウインドウの応答なし、アプリ側の読み込み失敗、
 *   PTY の起動失敗、IPC のハンドラの例外を、kind のタグ付きで送る。
 * - dev は送る前にスタックを元のファイルと行へ戻す（telemetrySourceMaps.ts）。
 */

/** 初期化したか（設定画面の「次の起動から」の案内と、renderer の初期化の判断に使う） */
let active = false
/** 確認用にわざと起こす例外（MOVIE_ADE_SENTRY_TEST） */
let testKinds: SentryTestKind[] = []
/** 同じ例外を2つの経路（PTY の起動失敗と、それを投げた IPC）から二重に送らない */
const reported = new WeakSet<object>()

export function crashReportsActive(): boolean {
  return active
}

export function sentryTestKinds(): SentryTestKind[] {
  return active ? testKinds : []
}

/** 設定はまだ読み込んでいない（非同期）ので、ここだけ settings.json を同期で読む */
function readCrashReportsSetting(): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')) as { crashReports?: unknown }
    return raw.crashReports !== false
  } catch {
    return true
  }
}

function scrubContext(): ScrubContext {
  const s = currentSettings()
  const projectPaths = [...s.projects.map((p) => p.folderPath), ...(s.folderPath ? [s.folderPath] : [])]
  // 長いパスから先に置き換える（親フォルダで先に置き換わると子が残る）
  return { homeDir: homedir(), projectPaths: [...new Set(projectPaths)].sort((a, b) => b.length - a.length) }
}

/** dev の release に付けるコミット。取れなければ null（release は +dev になる） */
function devGitHash(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: app.getAppPath(), timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** main で捕まえた例外を kind のタグ付きで送る。初期化していなければ何もしない */
export function reportMainError(err: unknown, tags: Record<string, string>): void {
  if (!active) return
  if (err && typeof err === 'object') {
    if (reported.has(err)) return
    reported.add(err)
  }
  Sentry.captureException(err, { tags })
}

/** 例外ではない異常（プロセスの終了・応答なし・読み込み失敗）を送る */
function reportMessage(message: string, level: 'error' | 'warning', tags: Record<string, string>): void {
  if (active) Sentry.captureMessage(message, { level, tags })
}

/**
 * アプリ自身の画面か。内蔵ブラウザ（利用者のページ）は別のセッション（browser.ts の PARTITION）で開くので、
 * 既定のセッションのものだけをアプリの画面（main の renderer・録画ウインドウ・プレビュー）として扱う。
 */
function isOwnContents(contents: WebContents): boolean {
  try {
    return contents.session === session.defaultSession
  } catch {
    // 破棄済みの webContents は session を読めない。判断できないものは送らない側に倒す
    return false
  }
}

function watchWebContents(contents: WebContents): void {
  contents.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!shouldReportLoadFailure({ ownPage: isOwnContents(contents), errorCode, isMainFrame })) return
    // URL は送らない（scrub でも落ちるが、メッセージに入れない）
    reportMessage(`did-fail-load: ${errorDescription} (${errorCode})`, 'error', {
      kind: 'did-fail-load', 'load.errorCode': String(errorCode), 'contents.type': contents.getType()
    })
  })
  contents.on('unresponsive', () => {
    if (isOwnContents(contents)) reportMessage('webContents unresponsive', 'warning', { kind: 'unresponsive', 'contents.type': contents.getType() })
  })
}

const anomalyGate = createAnomalyGate()

/**
 * main のイベントループが長く止まったら warning を送る（種類ごとに10分に1度）。
 * 250ms ごとのタイマーの遅れで測る。スタックは取れない（ネイティブの計測は入れていない）。
 */
function watchEventLoop(): void {
  const INTERVAL = 250
  let expected = Date.now() + INTERVAL
  const timer = setInterval(() => {
    const now = Date.now()
    const lag = now - expected
    expected = now + INTERVAL
    if (lag > EVENT_LOOP_BLOCK_MS && anomalyGate('event-loop')) {
      reportAnomaly('main event loop blocked', { kind: 'perf', perf: 'event-loop-block', duration: durationBucket(lag) })
    }
  }, INTERVAL)
  timer.unref?.()
}

function installProcessHooks(): void {
  app.on('render-process-gone', (_e, _contents, details) => {
    if (!shouldReportProcessGone(details.reason)) return
    reportMessage(`render-process-gone: ${details.reason}`, 'error', { kind: 'render-process-gone', reason: details.reason, exitCode: String(details.exitCode) })
  })
  app.on('child-process-gone', (_e, details) => {
    if (!shouldReportProcessGone(details.reason)) return
    reportMessage(`child-process-gone: ${details.type} ${details.reason}`, 'error', {
      kind: 'child-process-gone', reason: details.reason, 'process.type': details.type, exitCode: String(details.exitCode), ...(details.name ? { 'process.name': details.name } : {})
    })
  })
  // ウインドウの応答なしは webContents の unresponsive で拾う（BrowserWindow 以外の view も含む）
  app.on('web-contents-created', (_e, contents) => watchWebContents(contents))
  // console.error / warn のうち `[startup]` の失敗だけをパンくずに残す（console 全体は送らない）
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('[startup]')) {
        Sentry.addBreadcrumb({ category: 'startup', level: level === 'warn' ? 'warning' : 'error', message: args.map(String).join(' ') })
      }
      original(...args)
    }
  }
}

/** 他の初期化より先に、ready の前に呼ぶ（minidump を受けるため） */
export function initCrashReporting(): void {
  const dsn = resolveSentryDsn(process.env)
  const send = shouldSendCrashReports({
    e2e: process.env.ADE_E2E === '1',
    forced: process.env.MOVIE_ADE_SENTRY_FORCE === '1',
    unitTest: Boolean(process.env.VITEST),
    enabled: readCrashReportsSetting(),
    dsn
  })
  if (!send || !dsn) {
    // 送らないときも、クラッシュは Crashpad でローカルに受け止める（外部送信はしない）
    crashReporter.start({ uploadToServer: false, compress: true })
    return
  }

  const packaged = app.isPackaged
  const profile = telemetryProfile(packaged)
  const limit = createEventLimiter(profile.maxEventsPerRun)
  // 握りつぶしていた失敗・性能の異常（warning）は別に数え、クラッシュの枠を食わない
  const limitWarnings = createEventLimiter(profile.maxWarningsPerRun)
  // 外へ出るもの・画面の中身を拾うものは外す
  const DROP = new Set([
    'MainProcessSession', // 起動ごとのセッション
    'Screenshots',
    'Console', // console の出力（ターミナルの出力やパスが混ざる）
    'ElectronNet', // net の URL
    'NodeFetch',
    // スタックの変数の値（文字起こしや指摘の本文が入りうる）
    'LocalVariables',
    'LocalVariablesAsync',
    'LocalVariablesSync',
    'RendererEventLoopBlock',
    // 子プロセスの終了は installProcessHooks が kind のタグ付きで送る（パンくずだけ残す）
    'ChildProcess',
    'SentryMinidump'
  ])

  Sentry.init({
    dsn,
    release: packaged ? sentryRelease(version) : sentryRelease(version, { gitHash: devGitHash() }),
    environment: profile.environment,
    // 利用者の情報（IP・Cookie・ヘッダ・本文・変数）は集めない（旧 sendDefaultPii: false にあたる）
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false }
    },
    attachScreenshot: false,
    maxBreadcrumbs: 30,
    integrations: (defaults) => [
      // minidump の受け口は先頭のまま、1回の起動で送る数だけ絞る
      Sentry.sentryMinidumpIntegration({ maxMinidumpsPerSession: 3 }),
      ...defaults.filter((i) => !DROP.has(i.name)),
      Sentry.childProcessIntegration({ events: [] }),
      Sentry.dedupeIntegration()
    ],
    initialScope: {
      tags: { 'os.platform': process.platform, arch: process.arch, electron: process.versions.electron }
    },
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb, scrubContext()),
    beforeSend: async (event, hint) => {
      // 起動後に OFF にしたら、その時点から送らない
      if (!crashReportsEnabled(currentSettings())) return null
      const native = (hint.attachments ?? []).some((a) => a.attachmentType === 'event.minidump')
      if (!sampleEvent(native, Math.random, profile.sampleRate)) return null
      if (!packaged) await remapDevFrames(event, { appPath: app.getAppPath(), rendererUrl: process.env.ELECTRON_RENDERER_URL }).catch(() => undefined)
      if (!(event.level === 'warning' ? limitWarnings : limit)(event)) return null
      return scrubEvent(event, scrubContext())
    }
  })
  installProcessHooks()
  watchEventLoop()
  setReporter({
    handled: (err, tags, level) => Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { level, tags }),
    message: (message, tags, level) => Sentry.captureMessage(message, { level, tags }),
    breadcrumb: (message, data) => Sentry.addBreadcrumb({ category: 'flow', message, ...(data ? { data } : {}) })
  })
  testKinds = parseSentryTestKinds(process.env.MOVIE_ADE_SENTRY_TEST)
  active = true
}

/**
 * 確認用。MOVIE_ADE_SENTRY_TEST に main が入っていれば、起動後に main で未処理の Promise の拒否を起こす。
 * renderer / boundary / ipc は renderer 側（src/renderer/lib/telemetry.ts）が起こす。
 */
export function maybeSendTestEvent(): void {
  if (sentryTestKinds().includes('handled')) {
    // 握りつぶしていた失敗の経路（reportHandled）と、直前の流れのパンくず（flow）
    setTimeout(() => {
      flow('sentry test step', { step: 1 })
      reportHandled(new Error(`MOVIE-ADE Sentry test: handled failure ${homedir()}`), { area: 'settings', op: 'sentry test' })
    }, 1500)
  }
  if (!sentryTestKinds().includes('main')) return
  setTimeout(() => {
    // ホームのパスを入れて、送る前に ~ へ置き換わることも確かめる
    void Promise.reject(new Error(`MOVIE-ADE Sentry test: main unhandled rejection (${new Date().toISOString()}) ${homedir()}`))
  }, 1000)
}
