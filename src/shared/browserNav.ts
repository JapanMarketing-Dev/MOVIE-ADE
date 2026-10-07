import type { BrowserState, CaptureTarget } from './types'

/**
 * フィードバックモードのツールバーの「戻る／進む」（内蔵ブラウザの履歴）。
 * main（menu.ts のショートカット）と renderer（ボタンと案内）の両方から使うので Electron に依存しない。
 */
type BrowserNavDirection = 'back' | 'forward'

/** 戻る・進むを出すか。画面全体・ウインドウを録るときは内蔵ブラウザを操作しないので出さない */
export function showsBrowserNav(target: CaptureTarget): boolean {
  return target.kind === 'browser'
}

/** 押せるか（履歴があり、内蔵ブラウザが録画の対象のとき）。録画中も押せる */
export function canBrowserNav(
  direction: BrowserNavDirection,
  state: Pick<BrowserState, 'canGoBack' | 'canGoForward'>,
  target: CaptureTarget
): boolean {
  if (!showsBrowserNav(target)) return false
  return direction === 'back' ? state.canGoBack : state.canGoForward
}

/**
 * ショートカット（menu.ts の accelerator）。macOS は ⌘[ / ⌘]、それ以外は Alt+← / Alt+→（ブラウザと同じ）。
 * 注入スクリプトの書き込みのキー（P / B・R / V・Esc / C / ⌘Z）とは重ならない
 */
export function browserNavAccelerator(direction: BrowserNavDirection, platform: string): string {
  if (platform === 'darwin') return direction === 'back' ? 'Cmd+[' : 'Cmd+]'
  return direction === 'back' ? 'Alt+Left' : 'Alt+Right'
}

/** 画面に出すキー（renderer の formatShortcut に渡す並び）。browserNavAccelerator と対応させる */
export function browserNavKeys(direction: BrowserNavDirection, platform: string): string[] {
  if (platform === 'darwin') return ['Mod', direction === 'back' ? '[' : ']']
  return ['Alt', direction === 'back' ? 'ArrowLeft' : 'ArrowRight']
}

/**
 * 読み込みが中断された（Chromium の net::ERR_ABORTED、-3）か。次の読み込み・タブの入れ替え・閉じたタブで起きる想定内のもの。
 * Sentry へは送らない（FERRET-1R。loadURL・navigationHistory.restore の失敗に使う）
 */
export function isAbortedNavigation(err: unknown): boolean {
  const e = err as { errno?: unknown; code?: unknown; message?: unknown } | null
  if (!e || typeof e !== 'object') return false
  return e.errno === -3 || e.code === 'ERR_ABORTED' || (typeof e.message === 'string' && /^ERR_ABORTED \(-3\)/.test(e.message))
}
