import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import type { DesktopAppInfo, DesktopAppLaunch } from '@shared/types'
import { appNameFromPath, dedupeApps, isStartMenuNoise, macOpenArgs, parseBundleId, parseDesktopEntry, plutilBundleIdArgs, MAX_DESKTOP_APPS } from '@shared/desktopAppCatalog'
import { getLocale, t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'

/**
 * まだ画面に出ていないデスクトップアプリを、録画の対象の選択画面から起動・前面へ出す（REC-2 の拡張）。
 *
 * - 一覧: OS の決まった場所を読むだけ（中身は実行しない）。名前の付け方・絞り込みは @shared/desktopAppCatalog
 * - 起動: renderer から届くのは一覧の ID だけ。直前に main が並べた一覧にあるものしか起動しない（任意のパスを起動しない）。
 *   macOS は /usr/bin/open -a <.app>、Windows はショートカットを shell.openPath、Linux は gio launch / gtk-launch。
 *   どれもシェルを通さず、引数は配列で渡す
 */

const LAUNCH_TIMEOUT_MS = 10_000
const PLIST_TIMEOUT_MS = 2_000
/** 1つのフォルダの中を何段まで見るか（スタートメニューのフォルダ分け、/Applications の中のフォルダ） */
const MAX_DEPTH = 3

/** 直前に並べた一覧（ID → アプリ）。起動はここにあるものだけ */
let lastListed = new Map<string, DesktopAppInfo>()

function run(file: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true, shell: false }, (error, stdout) => {
      resolve({ ok: !error, stdout: error ? '' : stdout })
    })
  })
}

/** そのフォルダの下の、名前が合うもの（.app の中には入らない）。読めないフォルダは飛ばす */
async function walk(dir: string, accept: (name: string, isDir: boolean) => 'take' | 'descend' | 'skip', depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH || out.length >= MAX_DESKTOP_APPS) return out
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (out.length >= MAX_DESKTOP_APPS) break
    const full = join(dir, entry.name)
    // シンボリックリンクのフォルダはたどらない（同じ場所を何度も読まない）。.app のリンクは一覧に出す
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && /\.app$/i.test(entry.name))
    const verdict = accept(entry.name, isDir)
    if (verdict === 'take') out.push(full)
    else if (verdict === 'descend' && entry.isDirectory()) await walk(full, accept, depth + 1, out)
  }
  return out
}

async function listMac(home: string): Promise<DesktopAppInfo[]> {
  const roots = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(home, 'Applications')]
  const found: string[] = []
  for (const root of roots) {
    // /Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app のように1段下のフォルダにあるものも拾う
    await walk(root, (name, isDir) => (!isDir || name.startsWith('.') ? 'skip' : /\.app$/i.test(name) ? 'take' : 'descend'), MAX_DEPTH - 1, found)
  }
  return found.map((path) => ({ id: path, name: appNameFromPath(path), path }))
}

async function listWindows(env: NodeJS.ProcessEnv): Promise<DesktopAppInfo[]> {
  const roots = [env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
    env.ProgramData ? join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : ''].filter(Boolean)
  const found: string[] = []
  for (const root of roots) await walk(root, (name, isDir) => (isDir ? 'descend' : /\.lnk$/i.test(name) ? 'take' : 'skip'), 0, found)
  return found.map((path) => ({ id: path, name: appNameFromPath(path), path })).filter((app) => !isStartMenuNoise(app.name))
}

async function listLinux(home: string, env: NodeJS.ProcessEnv): Promise<DesktopAppInfo[]> {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((d) => d.startsWith('/'))
  const roots = [join(dataHome, 'applications'), ...dataDirs.map((d) => join(d, 'applications')),
    '/var/lib/flatpak/exports/share/applications', join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), '/var/lib/snapd/desktop/applications']
  const files: string[] = []
  for (const root of [...new Set(roots)]) await walk(root, (name, isDir) => (isDir ? 'descend' : /\.desktop$/i.test(name) ? 'take' : 'skip'), 1, files)
  const locale = getLocale()
  const apps: DesktopAppInfo[] = []
  for (const path of files) {
    const text = await readFile(path, 'utf8').catch(() => '')
    const entry = text.length < 256 * 1024 ? parseDesktopEntry(text, locale) : null
    if (entry) apps.push({ id: path, name: entry.name, path })
  }
  return apps
}

/** 入れてあるデスクトップアプリ。読めなければ空 */
export async function listDesktopApps(platform: NodeJS.Platform = process.platform): Promise<DesktopAppInfo[]> {
  const home = homedir()
  const raw = platform === 'darwin' ? await listMac(home) : platform === 'win32' ? await listWindows(process.env) : await listLinux(home, process.env)
  const apps = dedupeApps(raw)
  lastListed = new Map(apps.map((app) => [app.id, app]))
  return apps
}

/** macOS のアプリのバンドル ID（読むだけ）。読めなければ undefined */
async function bundleIdOf(appPath: string): Promise<string | undefined> {
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return undefined
  const { stdout } = await run('/usr/bin/plutil', plutilBundleIdArgs(plist), PLIST_TIMEOUT_MS)
  return parseBundleId(stdout)
}

/** Linux で .desktop を起動する道具（信頼できる場所にあるものだけ） */
function linuxLauncher(path: string): { file: string; args: string[] } | null {
  for (const gio of ['/usr/bin/gio', '/bin/gio']) if (existsSync(gio)) return { file: gio, args: ['launch', path] }
  const id = path.split('/').pop() ?? ''
  for (const gtk of ['/usr/bin/gtk-launch', '/bin/gtk-launch']) if (existsSync(gtk)) return { file: gtk, args: [id] }
  return null
}

/**
 * 一覧の1件を起動する（起動していれば前面へ出す）。一覧に無い ID は起動しない。
 * @returns ウインドウを探す手がかり（名前・バンドル ID）
 */
export async function launchDesktopApp(id: string, platform: NodeJS.Platform = process.platform): Promise<DesktopAppLaunch> {
  const app = typeof id === 'string' ? lastListed.get(id) : undefined
  if (!app) throw new UserFacingError(t('capture.apps.notListed'))
  if (platform === 'darwin') {
    const [result, bundleId] = await Promise.all([run('/usr/bin/open', macOpenArgs(app.path), LAUNCH_TIMEOUT_MS), bundleIdOf(app.path)])
    if (!result.ok) throw new UserFacingError(t('capture.apps.launchFailed', { name: app.name }))
    return { name: app.name, ...(bundleId ? { bundleId } : {}) }
  }
  if (platform === 'win32') {
    // ショートカットを開く（ShellExecute。シェルの文字列は作らない）。失敗すると理由の文が返る
    const problem = await shell.openPath(app.path)
    if (problem) {
      reportHandled(new Error(problem), { area: 'recording', op: 'launch desktop app' })
      throw new UserFacingError(t('capture.apps.launchFailed', { name: app.name }))
    }
    return { name: app.name }
  }
  const launcher = linuxLauncher(app.path)
  if (!launcher) throw new UserFacingError(t('capture.apps.noLauncher'))
  const result = await run(launcher.file, launcher.args, LAUNCH_TIMEOUT_MS)
  if (!result.ok) throw new UserFacingError(t('capture.apps.launchFailed', { name: app.name }))
  return { name: app.name }
}
