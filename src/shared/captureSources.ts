import type { CaptureSourceInfo } from './types'

/**
 * 画面全体の候補（desktopCapturer の screen）と、つないでいるディスプレイ（screen.getAllDisplays）の対応付け。
 * Electron に依存しない純粋な処理（main の recording/sources.ts と単体テストで使う）。
 *
 * macOS では、desktopCapturer の画面の ID は 'screen:<CGDirectDisplayID>:0'、display_id も同じ CGDirectDisplayID で、
 * Electron の Display.id とも同じ値になる。ところが環境によって（macOS の版・Chromium の取り込み方式）、画面の一覧に
 * メインの画面しか返らないことがある（2画面つないでいても「画面 1」しか出ない、という報告。原因の切り分けは実機で未確認）。
 * 取り込み自体は ID を指定すればどのディスプレイでもできるので、一覧に無いディスプレイは Display.id から ID を作って足す。
 *
 * Windows・Linux の画面の ID はディスプレイの並びの番号で、Display.id とは別の値なので、ID を作らない（一覧のまま）。
 */

export interface DisplayLike {
  id: number
  size: { width: number; height: number }
}

/** 画面の候補がどのディスプレイか。display_id があればそれ、macOS は ID の数字（CGDirectDisplayID）からも分かる */
export function displayIdOfScreen(sourceId: string, displayId: string | undefined, platform: string): string | undefined {
  if (displayId) return displayId
  if (platform !== 'darwin') return undefined
  const m = /^screen:(\d+):/.exec(sourceId)
  return m ? m[1] : undefined
}

/**
 * 一覧に無いディスプレイを、画面の候補として足す（macOS だけ）。サムネイルは無い（desktopCapturer が作らないため）。
 * 足す順はディスプレイの並び（screen.getAllDisplays の順）
 */
export function withMissingDisplays(sources: readonly CaptureSourceInfo[], displays: readonly DisplayLike[], platform: string, fallbackName: string): CaptureSourceInfo[] {
  if (platform !== 'darwin') return [...sources]
  const listed = new Set(sources.filter((s) => s.kind === 'screen').map((s) => displayIdOfScreen(s.id, s.displayId, platform)).filter((id): id is string => !!id))
  const extras = displays
    .filter((d) => Number.isInteger(d.id) && d.id > 0 && !listed.has(String(d.id)))
    .map((d): CaptureSourceInfo => ({ id: `screen:${d.id}:0`, kind: 'screen', name: fallbackName, displayId: String(d.id), thumbnail: '' }))
  if (extras.length === 0) return [...sources]
  // 画面は画面どうしで並べる（ウインドウの前に置く）
  const screens = sources.filter((s) => s.kind === 'screen')
  const others = sources.filter((s) => s.kind !== 'screen')
  return [...screens, ...extras, ...others]
}

/** 画面の候補をディスプレイの並び（Electron の順。番号「画面 1」「画面 2」と同じ）に揃える。分からないものは後ろ */
export function sortScreensByDisplay(sources: readonly CaptureSourceInfo[], displays: readonly DisplayLike[]): CaptureSourceInfo[] {
  const order = new Map(displays.map((d, i) => [String(d.id), i]))
  const rank = (s: CaptureSourceInfo) => (s.displayId !== undefined && order.has(s.displayId) ? order.get(s.displayId)! : displays.length)
  const screens = sources.filter((s) => s.kind === 'screen').map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s)
  return [...screens, ...sources.filter((s) => s.kind !== 'screen')]
}
