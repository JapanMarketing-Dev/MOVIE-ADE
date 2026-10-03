/**
 * electron-builder の dev 版の設定（`pnpm build:<os>:dev`）。本番の electron-builder.config.cjs を元に、
 * 識別子と名前だけを変えて、本番版と並べて入れても混ざらないようにする。
 * userData は製品名に関係なく ade-movie（src/main/index.ts）なので、設定は本番版と共有する。
 */
const base = require('./electron-builder.config.cjs')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  ...base,
  appId: 'com.japanmarketing.movieade.dev',
  productName: 'MOVIE-ADE Dev',
  artifactName: 'MOVIE-ADE-Dev-${version}-${os}-${arch}.${ext}',
  directories: { ...base.directories, output: 'dist/dev' },
  dmg: { ...base.dmg, artifactName: 'MOVIE-ADE-Dev-${version}-mac-${arch}.${ext}' },
  win: { ...base.win, executableName: 'MOVIE-ADE-Dev' },
  nsis: { ...base.nsis, artifactName: 'MOVIE-ADE-Dev-${version}-win-${arch}.${ext}' },
  linux: { ...base.linux, executableName: 'movie-ade-dev' },
  appImage: { ...base.appImage, artifactName: 'MOVIE-ADE-Dev-${version}-linux-${arch}.${ext}' },
  deb: { ...base.deb, packageName: 'movie-ade-dev', artifactName: 'MOVIE-ADE-Dev-${version}-linux-${arch}.${ext}' }
}
