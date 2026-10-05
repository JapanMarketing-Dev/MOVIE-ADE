import type { CaptureSourceInfo, CaptureTarget, ProjectKind, ProjectTarget } from './types'
import { KIND_FIELDS, matchWindowSource } from './projectTargets'
import { captureTargetLabel } from './captureTarget'
import type { SupportedLocale } from './i18n'

/**
 * 1本の録画で複数の映像（内蔵ブラウザ・デスクトップアプリのウインドウ・画面）を同時に録り、見るものを切り替えるための純粋な処理。
 * Electron に依存させない（main・renderer・単体テストで共用）。
 *
 * - トラック: 録画の映像の1本。最初のもの（main）は録画を始めたときの対象で、音声もここで録る。
 *   ほかのトラックは映像だけを別のファイル（tracks/<id>.webm）へ録る。どれも録画の時計（開始からのms）で始まりと終わりを控える
 * - 切り替え: 画面に映して書き込むトラックは1つ（active）。切り替えた時刻を操作ログ（track）に残し、指摘がどのトラックの話かを引く
 * - 待ち受け: 確認先に登録したウインドウ（windowMatch）を、録画中に現れたら自動で録る（watch）。
 *   Web アプリからデスクトップアプリを呼び出して起動する流れも、最初から最後まで録れる
 */

/** 同時に録る映像の上限（main を含む）。録画ウインドウ1つにつき映像の符号化が1本走るので、重くしすぎない */
export const MAX_CAPTURE_TRACKS = 4

/** 待ち受けのウインドウを探す間隔(ms) */
export const WATCH_POLL_MS = 1_000

/** 見ていないトラック（main 以外）のフレームレートの上限。見返し用なので低くてよい */
export const EXTRA_TRACK_MAX_FPS = 5
/** 見ていないトラック（main 以外）のビットレート(bps) */
export const EXTRA_TRACK_BITS_PER_SECOND = 600_000

/**
 * 録画中に現れたらどうするか（確認先の watch）。
 *   record … 一緒に録る（画面は今のまま）
 *   switch … 録って、画面もそのウインドウへ切り替える
 */
export type WatchMode = 'record' | 'switch'
export const WATCH_MODES: readonly WatchMode[] = ['record', 'switch']

export function sanitizeWatchMode(raw: unknown): WatchMode | undefined {
  return WATCH_MODES.includes(raw as WatchMode) ? (raw as WatchMode) : undefined
}

/** 録画中に待ち受けるウインドウ（確認先1件から作る） */
export interface WatchedWindow {
  /** 確認先の id */
  id: string
  label: string
  /** アプリ名・ウインドウ名の一部・バンドル ID・実行ファイルのパス */
  match: string
  mode: WatchMode
}

/** 画面に出すトラック1本 */
export interface CaptureTrackInfo {
  id: string
  kind: 'browser' | 'screen' | 'window'
  label: string
  /** いま録っている（ウインドウが閉じたら false。同じ確認先がまた現れたら新しいトラックになる） */
  live: boolean
  /** 画面に映して書き込んでいるトラック */
  active: boolean
  /** 待ち受けから自動で足したなら、その確認先の id */
  watchId?: string
}

/** recording:tracks で画面へ送るもの */
export interface CaptureTracksState {
  tracks: CaptureTrackInfo[]
  /** まだ現れていない待ち受けのウインドウ */
  waiting: Array<{ id: string; label: string }>
  /** 待ち受けを止めた理由（Wayland・画面収録の許可が無い）。止めていなければ無い */
  watchUnavailable?: 'wayland' | 'permission'
}

export const EMPTY_TRACKS_STATE: CaptureTracksState = { tracks: [], waiting: [] }

/** 確認先のうち、録画中に待ち受けるもの（ウインドウの名前があり、watch を選んだもの）。web のプロジェクトはウインドウの欄を出さないので待たない */
export function watchedWindows(targets: readonly ProjectTarget[], kind: ProjectKind): WatchedWindow[] {
  if (!KIND_FIELDS[kind].windowMatch) return []
  return targets.flatMap((target): WatchedWindow[] => {
    const match = target.windowMatch?.trim()
    const mode = sanitizeWatchMode(target.watch)
    return match && mode ? [{ id: target.id, label: target.label || match, match, mode }] : []
  })
}

/** 実行ファイル・アプリの拡張子。パスで書かれたときは名前だけにして比べる */
const APP_EXTENSIONS = /\.(exe|app|appimage|lnk|desktop|bat|cmd)$/i
/** バンドル ID（com.example.MyApp）。3つ以上の区切りで空白が無いもの */
const BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){2,}$/

/**
 * windowMatch の書き方を、比べる形に直す。
 *   - 実行ファイル・アプリのパス（/Applications/Foo.app、C:\Program Files\Foo\Foo.exe）は名前（Foo）
 *   - バンドル ID（com.example.Foo）は bundleId と、最後の語（Foo）。macOS 以外はバンドル ID が分からないので名前で探す
 *   - それ以外はそのまま（アプリ名・ウインドウ名の一部）
 */
export function windowMatchQuery(raw: string): { text: string; bundleId?: string } {
  const value = raw.trim()
  if (!value) return { text: '' }
  if (/[\\/]/.test(value)) {
    // 末尾の区切り（Foo.app/）は外す。Foo.app/Contents/MacOS/Foo のような中のパスは .app の名前を使う
    const trimmed = value.replace(/[\\/]+$/, '')
    const bundle = /([^\\/]+)\.app(?:[\\/]|$)/i.exec(trimmed)
    const base = bundle ? bundle[1]! : trimmed.split(/[\\/]/).pop() ?? ''
    return { text: base.replace(APP_EXTENSIONS, '') }
  }
  // com.acme.Desktop のような3語以上はバンドル ID（.desktop・.app で終わっていても拡張子とは見なさない）
  if (BUNDLE_ID.test(value)) return { text: value.split('.').pop() ?? value, bundleId: value }
  if (APP_EXTENSIONS.test(value)) return { text: value.replace(APP_EXTENSIONS, '') }
  return { text: value }
}

/**
 * 待ち受けの名前に合うウインドウ。バンドル ID が分かる（macOS）ならそれで、無ければ名前（アプリ名・題名）で選ぶ。
 * Windows・Linux は desktopCapturer が題名しか返さないので、題名に名前が含まれるウインドウになる
 */
export function matchWatchedWindow(sources: readonly CaptureSourceInfo[], match: string): CaptureSourceInfo | null {
  const query = windowMatchQuery(match)
  if (query.bundleId) {
    const byBundle = sources.filter((s) => s.kind === 'window' && s.bundleId === query.bundleId)
    if (byBundle.length > 0) return [...byBundle].sort((a, b) => a.name.length - b.name.length)[0]!
    // バンドル ID の分かるウインドウがあるのに当たらなければ、名前では探さない（別のアプリを取り違えない）
    if (sources.some((s) => s.bundleId)) return null
  }
  return matchWindowSource(sources, query.text)
}

/** 待ち受けの判断に使うトラックの形 */
export interface WatchTrack {
  id: string
  /** 画面・ウインドウの desktopCapturer の ID（内蔵ブラウザは無い） */
  sourceId?: string
  watchId?: string
  live: boolean
  /** 窓が消えたら閉じてよいか（main は閉じない。音声も録っているため） */
  closable: boolean
}

export type WatchAction =
  | { type: 'close'; trackId: string }
  | { type: 'open'; watch: WatchedWindow; source: CaptureSourceInfo }

/**
 * いまのウインドウの一覧から、閉じるトラックと新しく録るウインドウを決める。
 *   - 録っているウインドウが一覧から消えた（閉じた・アプリが終わった）トラックは閉じる
 *   - 録っていない待ち受けのうち、合うウインドウが現れたものは録る（ほかのトラックが録っているウインドウは選ばない）
 *   - 同時に録る数は max まで。超える分は次に空いたときに録る
 */
export function planWatch(input: { watched: readonly WatchedWindow[]; tracks: readonly WatchTrack[]; sources: readonly CaptureSourceInfo[]; max?: number }): WatchAction[] {
  const max = input.max ?? MAX_CAPTURE_TRACKS
  const present = new Set(input.sources.map((s) => s.id))
  const actions: WatchAction[] = []
  const live = input.tracks.filter((t) => t.live)
  const closing = new Set<string>()
  for (const track of live) {
    if (track.closable && track.sourceId && !present.has(track.sourceId)) {
      actions.push({ type: 'close', trackId: track.id })
      closing.add(track.id)
    }
  }
  const remaining = live.filter((t) => !closing.has(t.id))
  const used = new Set(remaining.map((t) => t.sourceId).filter((id): id is string => !!id))
  const watching = new Set(remaining.map((t) => t.watchId).filter((id): id is string => !!id))
  let count = remaining.length
  for (const watch of input.watched) {
    if (count >= max) break
    if (watching.has(watch.id)) continue
    const source = matchWatchedWindow(input.sources.filter((s) => s.kind === 'window' && !used.has(s.id)), watch.match)
    if (!source) continue
    actions.push({ type: 'open', watch, source })
    used.add(source.id)
    watching.add(watch.id)
    count++
  }
  return actions
}

/** まだ現れていない待ち受け（録っているトラックの無いもの） */
export function waitingWindows(watched: readonly WatchedWindow[], tracks: readonly Pick<WatchTrack, 'watchId' | 'live'>[]): Array<{ id: string; label: string }> {
  const live = new Set(tracks.filter((t) => t.live && t.watchId).map((t) => t.watchId))
  return watched.filter((w) => !live.has(w.id)).map((w) => ({ id: w.id, label: w.label }))
}

/**
 * 待ち受けが使えない理由。Linux の Wayland は、ウインドウの一覧を取るたびに OS（PipeWire のポータル）が選択の画面を出すので、
 * 1秒ごとに探すことができない。macOS は画面収録の許可が無いと題名が読めない（一覧を取ると確認が出ることもある）
 */
export function watchUnavailable(platform: string, env: Record<string, string | undefined>, screenAccess: string): CaptureTracksState['watchUnavailable'] | null {
  if (platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY)) return 'wayland'
  if (platform === 'darwin' && screenAccess !== 'granted') return 'permission'
  return null
}

/** 切り替えの記録（操作ログの track）の最小の形 */
interface TrackSwitch {
  t: number
  type: string
  track?: string
}

/**
 * その時刻に画面に映していたトラックの切り替え（操作ログの track）。録画が1本だけ（切り替えの記録が1種類以下）なら null。
 * 切り替える前の時刻は、最初の切り替え（録画の開始時に main を記録する）を使う
 */
export function activeTrackAt<E extends TrackSwitch>(events: readonly E[], t: number): E | null {
  const switches = events.filter((e) => e.type === 'track' && typeof e.track === 'string').sort((a, b) => a.t - b.t)
  if (new Set(switches.map((e) => e.track)).size <= 1) return null
  let found: E | null = switches[0] ?? null
  for (const e of switches) {
    if (e.t > t) break
    found = e
  }
  return found
}

/** トラックの id。main の次から t2, t3 …（ファイル名にもなるので英数字だけ） */
export function nextTrackId(existing: readonly string[]): string {
  const used = new Set(existing)
  for (let n = 2; ; n++) if (!used.has(`t${n}`)) return `t${n}`
}

/** トラックの id として受け付ける形（IPC で届いた値を確かめる） */
export function isTrackId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^(main|t\d{1,3})$/.test(raw)
}

/**
 * トラックの名前。指摘を映していたものごとにまとめる鍵にもなるので、変わりにくいものを使う。
 * 待ち受けから足したウインドウは確認先の名前、ほかのウインドウはアプリ名（分からなければ題名）、内蔵ブラウザ・画面は対象の名前
 */
export function trackLabel(target: CaptureTarget, watchLabel?: string, locale?: SupportedLocale): string {
  if (watchLabel?.trim()) return watchLabel.trim().slice(0, 200)
  if (target.kind === 'window') return (target.appName || target.name || captureTargetLabel(target, locale)).slice(0, 200)
  return captureTargetLabel(target, locale)
}

/** チップに出す短い名前（長い題名は省く） */
export function shortTrackLabel(label: string, max = 18): string {
  const s = label.trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
