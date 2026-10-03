/**
 * macOS の開発起動（pnpm dev）で、メニューバー・Dock・⌘Tab・アクティビティモニタに「Electron」と出ないよう、
 * 名前とアイコンを MOVIE-ADE Dev にした Electron.app の複製を用意する。
 *
 *   node scripts/prepare-dev-electron.mjs   → 複製の実行ファイルのパスを1行で出す（macOS 以外は何もしない）
 *
 * Orca由来: ~/bench/orca/config/scripts/run-electron-vite-dev.mjs（prepareMacDevElectronApp）,
 *           ~/bench/orca/config/scripts/dev-electron-bundle-identity.mjs（MIT, Copyright 2026 Lovecast Inc.）
 *
 * node_modules の Electron.app そのものは書き換えない。
 *   - pnpm はストアのファイルをハードリンクで置くので、書き換えると他のプロジェクトの Electron まで変わりうる
 *   - 動いている dev の Electron の署名が壊れ、子プロセス（Helper）の起動が止められるおそれがある
 * そこで node_modules/.cache/movie-ade-dev/ に APFS の複製（容量を取らない）を作り、Info.plist とアイコンを差し替えて
 * ad-hoc で署名し直す（書き換えると元の署名が無効になり、起動できなくなるため）。
 * scripts/dev.mjs がこのパスを ELECTRON_EXEC_PATH にして electron-vite を起動する。
 *
 * 何度流しても壊れない：Electron の版・差し替える値・アイコンの中身が同じなら、作り直さない（目印のファイルで判断）。
 * 作り直しても、中身が同じなら ad-hoc の署名（cdhash）も同じになる（確かめ済み）。キーチェーンの「常に許可」は
 * この cdhash に結び付くので、Electron の版かアイコンが変わったときだけ、もう一度許可を求められる。
 *
 * 注意：署名が変わるので、初回だけ macOS が「画面収録」「マイク」の許可と、キーチェーン（ade-movie Safe Storage）への
 * アクセスの許可を求め直す。名前・識別子は固定なので、2回目以降は求めない。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEV_APP_NAME = 'MOVIE-ADE Dev'
export const DEV_BUNDLE_ID = 'com.japanmarketing.movieade.dev'

/**
 * 入れ子の Helper（Renderer / GPU など）の新しい名前（Electron Helper (Renderer) → MOVIE-ADE Dev Helper (Renderer)）。
 * Electron は Helper を「本体の実行ファイル名 + Helper…」で探すので、本体の実行ファイルと一緒に、
 * Helper のフォルダ・実行ファイル・CFBundleExecutable もすべて揃えて変える（electron-builder と同じやり方）。
 * これでアクティビティモニタにも Electron と出なくなる。
 */
export function devHelperName(helperBundleName) {
  return helperBundleName.replace(/^Electron/, DEV_APP_NAME)
}

/** Info.plist の差し替え。値は固定にする（変えると署名が変わり、許可を求め直すことになる） */
export function devPlistPatches() {
  return [
    { key: 'CFBundleName', value: DEV_APP_NAME },
    { key: 'CFBundleDisplayName', value: DEV_APP_NAME },
    { key: 'CFBundleIdentifier', value: DEV_BUNDLE_ID }
  ]
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function prepareDevElectron() {
  if (process.platform !== 'darwin') return null
  const source = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
  const icon = join(root, 'build', 'icon.icns')
  if (!existsSync(source)) return null

  const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  const iconHash = existsSync(icon) ? createHash('sha256').update(readFileSync(icon)).digest('hex') : ''
  const marker = JSON.stringify({ electronVersion, iconHash, patches: devPlistPatches(), layout: 3 })

  const dir = join(root, 'node_modules', '.cache', 'movie-ade-dev')
  // .app のフォルダ名は、electron-vite が実行ファイルを直接起動したときの Dock の名前にもなる（署名の外）
  const app = join(dir, `${DEV_APP_NAME}.app`)
  const executable = join(app, 'Contents', 'MacOS', DEV_APP_NAME)
  const markerPath = join(dir, 'marker.json')
  if (existsSync(executable) && existsSync(markerPath) && readFileSync(markerPath, 'utf8') === marker) return executable

  // 別の場所で組み立ててから入れ替える。dev がこの .app から動いている最中でも、
  // 組み立て途中の半端な .app から Helper が起動されることがないようにする
  const building = join(dir, `building-${process.pid}`)
  rmSync(building, { recursive: true, force: true })
  mkdirSync(building, { recursive: true })
  const built = buildDevApp(source, join(building, `${DEV_APP_NAME}.app`), iconHash ? icon : null)
  const old = join(dir, `old-${process.pid}`)
  if (existsSync(app)) renameSync(app, old)
  renameSync(built, app)
  rmSync(old, { recursive: true, force: true })
  rmSync(building, { recursive: true, force: true })
  writeFileSync(markerPath, marker)
  return executable
}

/** source（Electron.app）を app へ複製し、名前・識別子・アイコンを差し替えて ad-hoc で署名し直す */
function buildDevApp(source, app, icon) {
  // -c は APFS の複製（clonefile）。使えないファイルシステムでは普通の複製にする
  try {
    execFileSync('/bin/cp', ['-cR', source, app])
  } catch {
    cpSync(source, app, { recursive: true, verbatimSymlinks: true })
  }
  const plist = join(app, 'Contents', 'Info.plist')
  const setPlist = (file, key, value) => execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, file])
  for (const { key, value } of devPlistPatches()) setPlist(plist, key, value)
  // 本体の実行ファイル: MacOS/Electron → MacOS/MOVIE-ADE Dev
  renameSync(join(app, 'Contents', 'MacOS', 'Electron'), join(app, 'Contents', 'MacOS', DEV_APP_NAME))
  setPlist(plist, 'CFBundleExecutable', DEV_APP_NAME)
  const frameworks = join(app, 'Contents', 'Frameworks')
  for (const entry of readdirSync(frameworks)) {
    if (!/^Electron Helper.*\.app$/.test(entry)) continue
    const oldName = entry.replace(/\.app$/, '')
    const name = devHelperName(oldName)
    const contents = join(frameworks, entry, 'Contents')
    renameSync(join(contents, 'MacOS', oldName), join(contents, 'MacOS', name))
    for (const key of ['CFBundleExecutable', 'CFBundleName', 'CFBundleDisplayName']) setPlist(join(contents, 'Info.plist'), key, name)
    renameSync(join(frameworks, entry), join(frameworks, `${name}.app`))
  }
  if (icon) {
    // Info.plist の CFBundleIconFile（electron.icns）はそのままにし、中身だけを差し替える
    cpSync(icon, join(app, 'Contents', 'Resources', 'electron.icns'))
  }
  // 書き換えで元の署名は無効になる。ad-hoc（-）で、入れ子の Framework / Helper ごと署名し直す
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
  return app
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const path = prepareDevElectron()
    if (path) console.log(path)
  } catch (err) {
    // 用意できなくても開発は止めない（元の Electron で起動する）
    console.warn(`[dev-electron] MOVIE-ADE Dev.app を用意できませんでした。Electron のまま起動します: ${err.message}`)
  }
}
