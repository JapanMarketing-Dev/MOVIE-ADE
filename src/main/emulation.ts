/**
 * x64 版を ARM64 の上でエミュレーションして動かしているか（macOS の Rosetta、Windows の Prism）。
 * エミュレーションでは起動や子プロセスが数倍遅くなるので、性能の報告（Slow startup など）のタグに付けて見分ける
 * （FERRET-K: ARM64 の VM で x64 版を動かした起動が 15.4 秒だった）。
 * 判定は Electron の app.runningUnderARM64Translation（macOS と Windows で使える）。値は呼び出し側が渡す。
 */
type EmulationKind = 'rosetta' | 'prism' | 'none'

export function emulationKind(platform: NodeJS.Platform, translated: boolean | undefined): EmulationKind {
  if (!translated) return 'none'
  if (platform === 'darwin') return 'rosetta'
  if (platform === 'win32') return 'prism'
  return 'none'
}
