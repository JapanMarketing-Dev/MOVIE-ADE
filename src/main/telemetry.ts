import { app, crashReporter } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Sentry from '@sentry/electron/main'
import {
  crashReportsEnabled,
  createEventLimiter,
  resolveSentryDsn,
  sampleEvent,
  scrubBreadcrumb,
  scrubEvent,
  sentryRelease,
  shouldSendCrashReports,
  type ScrubContext
} from '@shared/telemetry'
import { version } from '../../package.json'
import { currentSettings } from './settings'

/**
 * クラッシュレポート（Sentry）。設定の「クラッシュレポートを送る」と src/shared/telemetry.ts を参照。
 *
 * - 送るのは配布版だけ。dev 起動・E2E では初期化しない（Crashpad でローカルに受けるだけ）。
 * - 起動時に設定が OFF なら初期化しない。起動後に OFF にしたら beforeSend で全部捨てる
 *   （ON に戻したときは次の起動から送る。minidump の受け口は ready の前にしか入れられないため）。
 * - パフォーマンスの計測・セッション・リプレイ・スクリーンショットは使わない。
 */

/** 初期化したか（設定画面の「次の起動から」の案内と、renderer の初期化の判断に使う） */
let active = false

export function crashReportsActive(): boolean {
  return active
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

/** 他の初期化より先に、ready の前に呼ぶ（minidump を受けるため） */
export function initCrashReporting(): void {
  const forced = process.env.MOVIE_ADE_SENTRY_FORCE === '1'
  const dsn = resolveSentryDsn(process.env)
  const send = shouldSendCrashReports({
    packaged: app.isPackaged,
    forced,
    e2e: process.env.ADE_E2E === '1',
    enabled: readCrashReportsSetting(),
    dsn
  })
  if (!send || !dsn) {
    // 送らないときも、クラッシュは Crashpad でローカルに受け止める（外部送信はしない）
    crashReporter.start({ uploadToServer: false, compress: true })
    return
  }

  const limit = createEventLimiter()
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
    'RendererEventLoopBlock'
  ])

  Sentry.init({
    dsn,
    release: sentryRelease(version),
    environment: forced && !app.isPackaged ? 'verification' : 'production',
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
      ...defaults.filter((i) => !DROP.has(i.name) && i.name !== 'SentryMinidump'),
      Sentry.dedupeIntegration()
    ],
    initialScope: {
      tags: { 'os.platform': process.platform, arch: process.arch, electron: process.versions.electron }
    },
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb, scrubContext()),
    beforeSend: (event, hint) => {
      // 起動後に OFF にしたら、その時点から送らない
      if (!crashReportsEnabled(currentSettings())) return null
      const native = (hint.attachments ?? []).some((a) => a.attachmentType === 'event.minidump')
      if (!forced && !sampleEvent(native)) return null
      if (!limit(event)) return null
      return scrubEvent(event, scrubContext())
    }
  })
  active = true
}

/** 確認用。MOVIE_ADE_SENTRY_FORCE=1 と MOVIE_ADE_SENTRY_TEST=1 のときだけ、起動後にわざと例外を送る */
export function maybeSendTestEvent(): void {
  if (!active || process.env.MOVIE_ADE_SENTRY_TEST !== '1') return
  Sentry.captureException(new Error(`MOVIE-ADE Sentry test event (${new Date().toISOString()}) from ${homedir()}`))
  void Sentry.flush(5000)
  // renderer の未処理の例外も、preload 経由で main へ渡って届くことを確かめる
  app.once('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', () => {
      void win.webContents.executeJavaScript(`setTimeout(() => { throw new Error('MOVIE-ADE Sentry renderer test event at https://example.com/?q=1 ' + ${JSON.stringify(homedir())}) }, 2000)`)
    })
  })
}
