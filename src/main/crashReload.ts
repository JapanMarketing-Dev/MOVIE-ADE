/**
 * 画面（renderer）のプロセスが落ちたとき、読み込み直してよいか（純粋な関数。単体テストの対象）。
 *
 * 落ちたあと何もしないと白い画面のまま残り、アプリを終了するしかない（Orca #7742 #8260 #14549）。
 * ターミナルの PTY は main に残っているので、読み込み直せば restorePlan.ts の仕組みでそのままつなぎ直せる。
 * 読み込むたびに落ちる場合に繰り返さないよう、1分に3回までにする。正常な終了（clean-exit）では読み込まない
 */
export const CRASH_RELOAD_LIMIT = 3
export const CRASH_RELOAD_WINDOW_MS = 60_000

/** history（直近に読み込み直した時刻）を更新し、読み込み直すなら true */
export function allowCrashReload(history: number[], reason: string, now: number): boolean {
  if (reason === 'clean-exit') return false
  while (history.length > 0 && now - history[0]! > CRASH_RELOAD_WINDOW_MS) history.shift()
  if (history.length >= CRASH_RELOAD_LIMIT) return false
  history.push(now)
  return true
}
