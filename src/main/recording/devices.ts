import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureDevice } from '@shared/types'
import { emulatorPortOf, matchSimulator, parseAdbDevices, parseAndroidFocus, parseAvdName, parseMacWindowList, parseSimctlBooted, type MacWindowInfo } from '@shared/desktopApps'
import { resolveTrustedExecutable } from '../agentExecutable'

/**
 * デスクトップアプリ・スマホのシミュレータ／エミュレータの情報を、読むだけの命令で取る。
 *
 * - macOS のウインドウの一覧（アプリ名・常に手前のウインドウ）: /usr/bin/osascript の JXA で CGWindowListCopyWindowInfo を読む。
 *   ほかのアプリへ Apple Events を送らないので、オートメーションの許可は要らない。画素は読まない（題名・大きさ・アプリ名だけ）
 *   手前に出すウインドウの一覧のサムネイルだけは /usr/sbin/screencapture で撮る（画面収録の許可があるとき。captureMacWindowImage）
 * - iOS シミュレータ: /usr/bin/xcrun simctl list devices booted -j
 * - Android Emulator: adb devices / adb -s <serial> emu avd name / shell getprop / shell dumpsys window
 *
 * どれも上限時間付きの非同期の子プロセスで、シェルを通さず、信頼できる絶対パスで起動する（security-4 [1]・security-5 [5]）。
 * 取れなければ空・undefined を返す（録画は続ける。端末の情報は指摘の添え書きにすぎない）。
 */

const LIST_TIMEOUT_MS = 3_000
const DEVICE_TIMEOUT_MS = 2_500
const THUMBNAIL_TIMEOUT_MS = 3_000

function run(file: string, args: readonly string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false }, (error, stdout) => {
      // 無い・動かない・時間切れは空（想定内）
      resolve(error ? '' : stdout)
    })
  })
}

/** JXA。kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements の一覧を JSON で書く */
const MAC_WINDOW_LIST_JXA = [
  'ObjC.import("CoreGraphics");',
  'var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];',
  'JSON.stringify(list.map(function (w) { var b = w.kCGWindowBounds || {}; return { id: w.kCGWindowNumber, layer: w.kCGWindowLayer, owner: w.kCGWindowOwnerName || "",',
  ' pid: w.kCGWindowOwnerPID, name: w.kCGWindowName || "", w: b.Width, h: b.Height, sharing: w.kCGWindowSharingState, alpha: w.kCGWindowAlpha } }))'
].join('\n')

/** macOS の画面に出ているウインドウの一覧。macOS 以外・読めなければ空 */
export async function listMacWindows(platform: NodeJS.Platform = process.platform): Promise<MacWindowInfo[]> {
  if (platform !== 'darwin') return []
  return parseMacWindowList(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_WINDOW_LIST_JXA], LIST_TIMEOUT_MS))
}

/**
 * macOS のウインドウ1つの画像（JPEG）。手前に出すウインドウは desktopCapturer がサムネイルを作らないので、
 * /usr/sbin/screencapture -l <CGWindowID> で撮る。音を出さず（-x）、影を付けない（-o）。
 * 画面収録の許可が要る（呼ぶのは許可があるときだけ）。撮れなければ null
 */
export async function captureMacWindowImage(id: number, platform: NodeJS.Platform = process.platform): Promise<Buffer | null> {
  if (platform !== 'darwin' || !Number.isInteger(id) || id <= 0) return null
  const dir = await mkdtemp(join(tmpdir(), 'ferret-thumb-'))
  try {
    const file = join(dir, 'window.jpg')
    await run('/usr/sbin/screencapture', screencaptureWindowArgs(id, file), THUMBNAIL_TIMEOUT_MS)
    const image = await readFile(file).catch(() => null)
    return image && image.length > 0 ? image : null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** screencapture の引数（シェルを通さないので、ID とパスはそのまま1つずつ渡す） */
export function screencaptureWindowArgs(id: number, file: string): string[] {
  return ['-x', '-o', `-l${id}`, '-t', 'jpg', file]
}

/** iOS シミュレータの端末の情報（ウインドウの題名に合う起動中の端末） */
export async function readSimulator(title: string): Promise<CaptureDevice> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/xcrun')) return { platform: 'ios' }
  const booted = parseSimctlBooted(await run('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], DEVICE_TIMEOUT_MS))
  const device = matchSimulator(title, booted)
  return { platform: 'ios', ...(device ? { name: device.name, ...(device.os ? { os: device.os } : {}) } : {}) }
}

/** adb を探す場所（Android SDK の platform-tools）。ANDROID_HOME・ANDROID_SDK_ROOT・Android Studio の既定の場所 */
export function adbCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb'
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((d): d is string => !!d)
  if (platform === 'darwin') sdks.push(join(home, 'Library', 'Android', 'sdk'))
  else if (platform === 'win32') { if (env.LOCALAPPDATA) sdks.push(join(env.LOCALAPPDATA, 'Android', 'Sdk')) }
  else sdks.push(join(home, 'Android', 'Sdk'))
  return [...new Set(sdks.map((sdk) => join(sdk, 'platform-tools', exe)))]
}

async function findAdb(): Promise<string | null> {
  const home = homedir()
  // 相対の指定・プロジェクトの中の adb は使わない（cwd はホーム。SDK の場所は絶対パス）
  for (const candidate of adbCandidates(process.platform, process.env, home)) {
    const found = await resolveTrustedExecutable(candidate, { env: process.env, cwd: home, home })
    if (found.ok) return found.path
  }
  const found = await resolveTrustedExecutable('adb', { env: process.env, cwd: home, home })
  return found.ok ? found.path : null
}

/** Android Emulator の端末の情報（ウインドウの題名のポートに合う端末。分からなければ1台だけのときそれ） */
export async function readEmulator(title: string): Promise<CaptureDevice> {
  const adb = await findAdb()
  if (!adb) return { platform: 'android' }
  const serials = parseAdbDevices(await run(adb, ['devices'], DEVICE_TIMEOUT_MS))
  const port = emulatorPortOf(title)
  const serial = (port !== null ? serials.find((s) => s === `emulator-${port}`) : undefined) ?? (serials.length === 1 ? serials[0] : undefined)
  if (!serial) return { platform: 'android' }
  const [avd, model, release, focus] = await Promise.all([
    serial.startsWith('emulator-') ? run(adb, ['-s', serial, 'emu', 'avd', 'name'], DEVICE_TIMEOUT_MS) : Promise.resolve(''),
    run(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model'], DEVICE_TIMEOUT_MS),
    run(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], DEVICE_TIMEOUT_MS),
    run(adb, ['-s', serial, 'shell', 'dumpsys', 'window'], DEVICE_TIMEOUT_MS)
  ])
  const name = parseAvdName(avd) ?? (model.trim() || undefined)
  const version = release.trim()
  const app = parseAndroidFocus(focus)
  return { platform: 'android', ...(name ? { name } : {}), ...(/^[\w.]+$/.test(version) ? { os: `Android ${version}` } : {}), ...(app ? { app } : {}) }
}

/** 端末の種類に合わせて読む */
export function readDevice(platform: CaptureDevice['platform'], title: string): Promise<CaptureDevice> {
  return platform === 'ios' ? readSimulator(title) : readEmulator(title)
}
