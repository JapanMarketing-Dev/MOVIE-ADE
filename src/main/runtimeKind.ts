/**
 * 配布版か開発版かの判定（Electron に依存しない。単体テストから使う）。
 *
 * Electron の isPackaged（app の）は「実行ファイル名が electron でない」で決まるので、
 * 名前を変えた開発版の Electron（Ferret.app。scripts/prepare-dev-electron.mjs）でも true になる。
 * 開発起動は `electron .`（process.defaultApp が true）か、Vite の dev サーバー（ELECTRON_RENDERER_URL）で見分ける。
 * 配布版はどちらも無い。
 */
export function isPackagedBuild(opt: { isPackaged: boolean; defaultApp?: boolean; rendererUrl?: string }): boolean {
  return opt.isPackaged && !opt.defaultApp && !opt.rendererUrl
}
