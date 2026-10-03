import type { ITerminalOptions } from '@xterm/xterm'

/**
 * Windows の PTY（node-pty は ConPTY を使う）を xterm に伝える設定。
 * Windows 10 の古い ConPTY（ビルド 21376 より前）は折り返しの印を送らないので、xterm が推し量る処理を入れる。
 * ビルド番号は OS の版（process.getSystemVersion()、例 10.0.22631）の3つ目。読めなければ渡さない（推し量らない）
 */
export function windowsPtyOption(platform: string, systemVersion: string | undefined): ITerminalOptions['windowsPty'] {
  if (platform !== 'win32') return undefined
  const build = Number.parseInt(systemVersion?.split('.')[2] ?? '', 10)
  return Number.isFinite(build) && build > 0 ? { backend: 'conpty', buildNumber: build } : { backend: 'conpty' }
}
