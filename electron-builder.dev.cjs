/**
 * electron-builder の dev 版の設定（`pnpm build:<os>:dev`）。本番の electron-builder.config.cjs を元に、
 * 識別子と名前だけを変えて、本番版と並べて入れても混ざらないようにする。
 * userData は製品名に関係なく ade-movie（src/main/index.ts）なので、設定は本番版と共有する。
 */
const base = require('./electron-builder.config.cjs')
// guid は本番版のもの（旧 MOVIE-ADE を置き換えるため）を引き継がない。dev は appId から作らせる
const { guid: _releaseGuid, ...baseNsis } = base.nsis

/** @type {import('electron-builder').Configuration} */
module.exports = {
  ...base,
  appId: 'dev.ferretade.ferret.dev',
  // 表示名は配布版と同じ Ferret。識別子とファイル名（Ferret-Dev-…）で分ける
  productName: 'Ferret',
  artifactName: 'Ferret-Dev-${version}-${os}-${arch}.${ext}',
  directories: { ...base.directories, output: 'dist/dev' },
  dmg: { ...base.dmg, artifactName: 'Ferret-Dev-${version}-mac-${arch}.${ext}' },
  win: { ...base.win, executableName: 'Ferret-Dev' },
  nsis: { ...baseNsis, artifactName: 'Ferret-Dev-${version}-win-${arch}.${ext}' },
  linux: { ...base.linux, executableName: 'ferret-dev' },
  appImage: { ...base.appImage, artifactName: 'Ferret-Dev-${version}-linux-${arch}.${ext}' },
  deb: { ...base.deb, packageName: 'ferret-dev', fpm: [], artifactName: 'Ferret-Dev-${version}-linux-${arch}.${ext}' }
}
