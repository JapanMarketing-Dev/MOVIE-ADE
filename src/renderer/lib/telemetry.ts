import { addBreadcrumb, captureException, captureMessage, init } from '@sentry/electron/renderer'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderErrorCapture, type SentryTestKind } from '@shared/telemetry'
import { setReporter } from '@shared/report'
import { ErrorBoundary } from '../ui/ErrorBoundary'

/**
 * renderer のクラッシュレポート（src/main/telemetry.ts の続き）。
 *
 * main が Sentry を初期化した起動（設定が ON で E2E でないとき。dev も含む）だけ初期化する。
 * イベントは main へ渡り、main の beforeSend で個人の情報を落としてから送られる。
 * 内蔵ブラウザのページは別のセッションなので対象外（アプリの画面の例外だけ）。
 * ここでは画面の操作の記録（クリック・console・fetch・画面遷移）を最初から集めない。
 */
let initialized = false

export async function initRendererCrashReporting(): Promise<void> {
  const state = await window.ade.invoke('telemetry:state').catch(() => null)
  if (!state?.active || !state.enabled) return
  init({
    // Breadcrumbs = クリック・console・fetch の記録。HttpContext = ページの URL
    integrations: (defaults) => defaults.filter((i) => i.name !== 'Breadcrumbs' && i.name !== 'HttpContext'),
    maxBreadcrumbs: 30
  })
  initialized = true
  // 握りつぶしていた失敗・流れの区切りの送り先（src/shared/report.ts）。パンくずは main へ渡り、そこで scrub される
  setReporter({
    handled: (err, tags, level) => captureException(err instanceof Error ? err : new Error(String(err)), { level, tags }),
    message: (message, tags, level) => captureMessage(message, { level, tags }),
    breadcrumb: (message, data) => addBreadcrumb({ category: 'flow', message, ...(data ? { data } : {}) })
  })
  keepStartupFailures()
  runSentryTests(state.test)
}

/** console.error は送らない（騒がしい）。`[startup]` の失敗だけをパンくずに残す */
function keepStartupFailures(): void {
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[startup]')) {
      addBreadcrumb({ category: 'startup', level: 'error', message: args.map(String).join(' ') })
    }
    original(...args)
  }
}

/** ErrorBoundary で捕まえた描画のエラーを送る。componentStack はコンポーネントの階層 */
export function reportRenderError(error: unknown, boundary: string, componentStack?: string | null): void {
  if (!initialized) return
  captureException(error, renderErrorCapture(boundary, componentStack))
}

function TestBomb(): never {
  throw new Error('MOVIE-ADE Sentry test: render error in ErrorBoundary')
}

/**
 * 確認用（MOVIE_ADE_SENTRY_TEST）。起動の少しあとに、選んだ種類の例外をわざと起こす。
 * boundary は画面に出ない要素の中で、本物の ErrorBoundary に捕まえさせる。
 */
function runSentryTests(kinds: SentryTestKind[]): void {
  if (kinds.length === 0) return
  window.setTimeout(() => {
    if (kinds.includes('renderer')) {
      window.setTimeout(() => { throw new Error('MOVIE-ADE Sentry test: renderer uncaught error') }, 0)
      // 例外の直後は Sentry が window.onerror を少しのあいだ無視するので、間をあけて起こす
      window.setTimeout(() => { void Promise.reject(new Error('MOVIE-ADE Sentry test: renderer unhandled rejection')) }, 1000)
    }
    if (kinds.includes('boundary')) {
      const host = document.createElement('div')
      host.hidden = true
      document.body.append(host)
      createRoot(host).render(createElement(ErrorBoundary, { name: 'sentry-test', children: createElement(TestBomb) }))
    }
    if (kinds.includes('ipc')) {
      // 登録されていないプロジェクトへの切り替えは main のハンドラで例外になる
      void window.ade.invoke('project:switch', 'sentry-test-missing-project').catch(() => undefined)
    }
  }, 3000)
}
