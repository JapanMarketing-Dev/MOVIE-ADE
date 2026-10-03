import { init } from '@sentry/electron/renderer'

/**
 * renderer のクラッシュレポート（src/main/telemetry.ts の続き）。
 *
 * main が Sentry を初期化した起動（配布版で設定が ON）のときだけ初期化する。
 * イベントは main へ渡り、main の beforeSend で個人の情報を落としてから送られる。
 * 内蔵ブラウザのページは別のセッションなので対象外（アプリの画面の例外だけ）。
 * ここでは画面の操作の記録（クリック・console・fetch・画面遷移）を最初から集めない。
 */
export async function initRendererCrashReporting(): Promise<void> {
  const state = await window.ade.invoke('telemetry:state').catch(() => null)
  if (!state?.active || !state.enabled) return
  init({
    // Breadcrumbs = クリック・console・fetch の記録。HttpContext = ページの URL
    integrations: (defaults) => defaults.filter((i) => i.name !== 'Breadcrumbs' && i.name !== 'HttpContext'),
    maxBreadcrumbs: 0
  })
}
