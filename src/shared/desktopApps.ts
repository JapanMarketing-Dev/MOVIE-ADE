import type { CaptureSourceInfo, CaptureDevice } from './types'

/**
 * デスクトップアプリ・スマホのシミュレータ／エミュレータのウインドウを録画の対象に出すための、純粋な処理。
 * Electron に依存させない（main・renderer・単体テストで共用）。
 *
 * desktopCapturer（Chromium の WebRTC）は、macOS で「普通の高さ（layer 0）」のウインドウしか一覧に出さない。
 * 常に手前に出すウインドウ（Electron の alwaysOnTop、パネル）は、開発中のアプリの設定画面などでよく使うが、一覧から落ちる。
 * そこで main（recording/sources.ts）が macOS のウインドウの一覧（CGWindowList）を読み、ここで絞って候補に足す。
 * 同じ一覧から、各ウインドウのアプリ名も付ける（desktopCapturer は題名しか返さない）。
 */

/** macOS のウインドウの一覧の1件（CGWindowListCopyWindowInfo の項目から必要なものだけ） */
export interface MacWindowInfo {
  /** CGWindowID。desktopCapturer の ID 'window:<id>:0' の <id> */
  id: number
  layer: number
  owner: string
  pid: number
  name: string
  width: number
  height: number
  /** 0 は他のアプリから見せない設定（setContentProtection）。録っても黒くなるので出さない */
  sharing: number
  alpha: number
}

/** 手前に出す普通のウインドウの高さの範囲。20 以上は Dock・メニューバー・メニュー・カーソルなど OS の部品 */
const MAX_APP_LAYER = 19
/** OS の部品のウインドウ（画面の録画の対象にならないもの） */
const SYSTEM_OWNERS = new Set(['Window Server', 'Dock', 'Control Center', 'SystemUIServer', 'Notification Center', 'NotificationCenter',
  'Spotlight', 'WindowManager', 'Wallpaper', 'loginwindow', 'TextInputMenuAgent', 'TextInputSwitcher', 'universalAccessAuthWarn', 'screencaptureui'])
/** 足すウインドウの最小の大きさ（ツールチップ・小さな飾りを出さない） */
const MIN_EXTRA_WIDTH = 120
const MIN_EXTRA_HEIGHT = 80

/** JXA が書いた JSON を読む。形の合わない項目は捨てる。壊れていれば空 */
export function parseMacWindowList(json: string): MacWindowInfo[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 300) : '')
  const out: MacWindowInfo[] = []
  for (const item of raw.slice(0, 2000)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = num(r.id, -1)
    if (!Number.isInteger(id) || id <= 0) continue
    out.push({ id, layer: num(r.layer, 0), owner: str(r.owner), pid: num(r.pid, -1), name: str(r.name),
      width: num(r.w, 0), height: num(r.h, 0), sharing: num(r.sharing, 1), alpha: num(r.alpha, 1) })
  }
  return out
}

/** 録画の候補に足してよい、手前に出すウインドウか（layer 0 は desktopCapturer が出すので足さない） */
export function isExtraAppWindow(w: MacWindowInfo, ownPid: number): boolean {
  return w.layer > 0 && w.layer <= MAX_APP_LAYER && w.pid !== ownPid && !SYSTEM_OWNERS.has(w.owner) && w.sharing !== 0 && w.alpha > 0.05 &&
    w.name.trim().length > 0 && w.width >= MIN_EXTRA_WIDTH && w.height >= MIN_EXTRA_HEIGHT
}

/** desktopCapturer の ID から CGWindowID を取り出す（'window:123:0' → 123） */
export function windowNumberOf(sourceId: string): number | null {
  const m = /^window:(\d+):/.exec(sourceId)
  return m ? Number(m[1]) : null
}

/**
 * ウインドウがスマホのシミュレータ／エミュレータか。
 * iOS シミュレータは Xcode の Simulator.app（アプリ名 Simulator）。
 * Android Emulator は単体で開くと題名が「Android Emulator - <AVD名>:<ポート>」（アプリ名は qemu-system-… のことが多い）
 */
export function deviceKindOf(appName: string | undefined, title: string): CaptureDevice['platform'] | undefined {
  if (appName === 'Simulator') return 'ios'
  if (/^Android Emulator\b/i.test(title) || /^qemu-system-/i.test(appName ?? '') || appName === 'Android Emulator') return 'android'
  return undefined
}

/** ゲームエンジンのエディタ（Unity・Unreal・Godot）。アプリ名か題名から分かるときだけ。ビルドしたゲームはエンジンを決めない */
export type GameEngine = 'Unity' | 'Unreal Engine' | 'Godot'

export function gameEngineOf(appName: string | undefined, title: string): GameEngine | undefined {
  const app = appName ?? ''
  // Unity のエディタはアプリ名 Unity、題名「<プロジェクト> - <シーン> - <対象> - Unity 6000.0.x <DX11>」
  if (/^Unity$/i.test(app) || /\s-\sUnity\s\d/.test(title)) return 'Unity'
  if (/^(UnrealEditor|UE4Editor|Unreal Editor)$/i.test(app) || /\s-\sUnreal Editor$/.test(title)) return 'Unreal Engine'
  if (/^Godot/i.test(app) || /\s-\sGodot Engine$/.test(title)) return 'Godot'
  return undefined
}

/** Android Emulator の題名からポート（adb のシリアル emulator-<ポート>）を取る */
export function emulatorPortOf(title: string): number | null {
  const m = /:(\d{4,5})\s*$/.exec(title)
  return m ? Number(m[1]) : null
}

/**
 * desktopCapturer の候補に、アプリ名・スマホの種類を付け、macOS の手前に出すウインドウを足す。
 * macWindows が空（macOS 以外・読めなかった）なら、題名から分かるスマホの種類だけ付ける
 */
export function withAppWindows(sources: CaptureSourceInfo[], macWindows: MacWindowInfo[], ownPid: number): CaptureSourceInfo[] {
  const byId = new Map(macWindows.map((w) => [w.id, w]))
  const annotated = sources.map((source): CaptureSourceInfo => {
    if (source.kind !== 'window') return source
    const n = windowNumberOf(source.id)
    const appName = (n !== null ? byId.get(n)?.owner : undefined) || source.appName
    const device = deviceKindOf(appName, source.name)
    return { ...source, ...(appName ? { appName } : {}), ...(device ? { device } : {}) }
  })
  const listed = new Set(sources.map((s) => windowNumberOf(s.id)).filter((n): n is number => n !== null))
  const extras = macWindows
    .filter((w) => !listed.has(w.id) && isExtraAppWindow(w, ownPid))
    .map((w): CaptureSourceInfo => {
      const device = deviceKindOf(w.owner, w.name)
      return { id: `window:${w.id}:0`, kind: 'window', name: w.name, thumbnail: '', ...(w.owner ? { appName: w.owner } : {}), ...(device ? { device } : {}) }
    })
  return [...annotated, ...extras]
}

/** アプリ名ごとにまとめる（一覧の順を保つ）。アプリ名が分からないウインドウは '' にまとめる */
export function groupByApp(sources: CaptureSourceInfo[]): Array<{ appName: string; windows: CaptureSourceInfo[] }> {
  const groups = new Map<string, CaptureSourceInfo[]>()
  for (const s of sources) {
    const key = s.appName ?? ''
    const list = groups.get(key)
    if (list) list.push(s)
    else groups.set(key, [s])
  }
  return [...groups].map(([appName, windows]) => ({ appName, windows }))
}

// ───────────────────────── スマホの端末の情報（読むだけの命令の出力を解く） ─────────────────────────

/** `xcrun simctl list devices booted -j` の出力から、起動中の端末 */
export function parseSimctlBooted(json: string): Array<{ udid: string; name: string; os: string }> {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const devices = (raw as { devices?: unknown } | null)?.devices
  if (!devices || typeof devices !== 'object') return []
  const out: Array<{ udid: string; name: string; os: string }> = []
  for (const [runtime, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    // com.apple.CoreSimulator.SimRuntime.iOS-18-2 → iOS 18.2
    const m = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(runtime)
    const os = m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : ''
    for (const d of list) {
      const r = d as Record<string, unknown> | null
      if (!r || r.state !== 'Booted' || typeof r.udid !== 'string' || typeof r.name !== 'string') continue
      out.push({ udid: r.udid, name: r.name.slice(0, 120), os })
    }
  }
  return out
}

/** シミュレータのウインドウの題名に合う端末（題名は「iPhone 16 Pro」か「iPhone 16 Pro – iOS 18.2」）。合わなければ1台だけのときそれ */
export function matchSimulator<T extends { name: string }>(title: string, booted: T[]): T | undefined {
  const hits = booted.filter((d) => title === d.name || title.startsWith(`${d.name} `) || title.startsWith(`${d.name} –`) || title.startsWith(`${d.name} -`))
  // 「iPhone 16」と「iPhone 16 Pro」のように前方が同じ名前は、長い方を選ぶ
  if (hits.length > 0) return hits.sort((a, b) => b.name.length - a.name.length)[0]
  return booted.length === 1 ? booted[0] : undefined
}

/** `adb devices` の出力から、使える端末のシリアル */
export function parseAdbDevices(text: string): string[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === 'device' && /^[\w.:-]+$/.test(cols[0]!))
    .map((cols) => cols[0]!)
}

/** `adb shell dumpsys window` の mCurrentFocus / mFocusedApp から、前面のアプリのパッケージ名 */
export function parseAndroidFocus(text: string): string | undefined {
  for (const pattern of [/mCurrentFocus=Window\{[^}]*\s([\w.]+)\/[\w.$]+\}/, /mFocusedApp=.*?\s([\w.]+)\/[\w.$]+/]) {
    const m = pattern.exec(text)
    if (m && m[1]!.includes('.')) return m[1]
  }
  return undefined
}

/** `adb emu avd name` の出力の1行目（最後に OK が付く） */
export function parseAvdName(text: string): string | undefined {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && l !== 'OK')
  return first && /^[\w.-]+$/.test(first) ? first : undefined
}
