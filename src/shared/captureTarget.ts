import type { CaptureDevice, CaptureSourceInfo, CaptureTarget } from './types'
import { getLocale, translate, type SupportedLocale } from './i18n'
import { deviceKindOf, gameEngineOf } from './desktopApps'

/**
 * 録画の対象（内蔵ブラウザ／画面全体／別のウインドウ）の扱い。
 * Electron に依存しない純粋な処理だけを置く（main・renderer・単体テストで共用）。
 */

export const BROWSER_TARGET: CaptureTarget = { kind: 'browser' }

/** 設定ファイルから読んだ値を型どおりに直す。壊れていれば undefined（＝内蔵ブラウザ） */
export function sanitizeCaptureTarget(raw: unknown): CaptureTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<Record<'kind' | 'sourceId' | 'name' | 'displayId' | 'appName' | 'device', unknown>>
  if (r.kind === 'browser') return { kind: 'browser' }
  if (r.kind !== 'screen' && r.kind !== 'window') return undefined
  if (typeof r.sourceId !== 'string' || !r.sourceId.startsWith(`${r.kind}:`)) return undefined
  const name = typeof r.name === 'string' ? r.name.slice(0, 200) : ''
  const displayId = typeof r.displayId === 'string' && r.displayId.length > 0 ? r.displayId : undefined
  const appName = r.kind === 'window' && typeof r.appName === 'string' && r.appName.length > 0 ? r.appName.slice(0, 200) : undefined
  const device = r.kind === 'window' ? sanitizeDevice(r.device) : undefined
  return { kind: r.kind, sourceId: r.sourceId, name, ...(displayId ? { displayId } : {}), ...(appName ? { appName } : {}), ...(device ? { device } : {}) }
}

/** 端末の情報（capture.json から読んだ値）を型どおりに直す */
export function sanitizeDevice(raw: unknown): CaptureDevice | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<Record<keyof CaptureDevice, unknown>>
  if (r.platform !== 'ios' && r.platform !== 'android') return undefined
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 120) : undefined)
  const name = text(r.name)
  const os = text(r.os)
  const app = text(r.app)
  return { platform: r.platform, ...(name ? { name } : {}), ...(os ? { os } : {}), ...(app ? { app } : {}) }
}

/** 選択画面で選んだ1件を、覚えておく形へ直す */
export function targetFromSource(source: CaptureSourceInfo): CaptureTarget {
  return { kind: source.kind, sourceId: source.id, name: source.name, ...(source.displayId ? { displayId: source.displayId } : {}),
    ...(source.kind === 'window' && source.appName ? { appName: source.appName } : {}) }
}

/**
 * 覚えていた対象を、いまの候補の中から探す。
 *
 * desktopCapturer の ID はアプリや OS の再起動で変わる。ID で見つからなければ、
 * 画面は displayId、ウインドウは名前（タイトル）が同じものを使う（アプリ名が分かれば同じアプリのものに絞る）。
 * それでも無ければ、同じアプリのウインドウ（開発中のアプリを起動し直して題名が変わった）、
 * 同じ種類のスマホのシミュレータ／エミュレータのウインドウが1つだけならそれを使う。
 * 候補が複数あるときは取り違えないよう、見つからない扱いにする。
 *
 * @returns 見つかった対象（ID を今のものに直したもの）。見つからなければ null
 */
export function resolveCaptureTarget(saved: CaptureTarget, sources: CaptureSourceInfo[]): CaptureTarget | null {
  if (saved.kind === 'browser') return saved
  const sameKind = sources.filter((s) => s.kind === saved.kind)
  const byId = sameKind.find((s) => s.id === saved.sourceId)
  if (byId) return targetFromSource(byId)
  if (saved.kind === 'screen' && saved.displayId) {
    const byDisplay = sameKind.find((s) => s.displayId === saved.displayId)
    if (byDisplay) return targetFromSource(byDisplay)
  }
  if (saved.kind !== 'window') return null
  const sameApp = (s: CaptureSourceInfo) => !saved.appName || !s.appName || s.appName === saved.appName
  if (saved.name) {
    const byName = sameKind.filter((s) => s.name === saved.name && sameApp(s))
    if (byName.length === 1) return targetFromSource(byName[0]!)
  }
  if (saved.appName) {
    const byApp = sameKind.filter((s) => s.appName === saved.appName)
    if (byApp.length === 1) return targetFromSource(byApp[0]!)
  }
  const platform = saved.device?.platform
  if (platform) {
    const byDevice = sameKind.filter((s) => s.device === platform)
    if (byDevice.length === 1) return targetFromSource(byDevice[0]!)
  }
  return null
}

/** 画面やログに出す短い名前（例「画面全体（画面 1）」「ウインドウ「Figma」」） */
export function captureTargetLabel(target: CaptureTarget, locale: SupportedLocale = getLocale()): string {
  if (target.kind === 'browser') return translate(locale, 'capture.target.browser')
  if (target.kind === 'screen') return target.name ? translate(locale, 'capture.target.screenNamed', { name: target.name }) : translate(locale, 'capture.target.screen')
  const platform = target.device?.platform ?? deviceOfWindow(target)
  if (platform) return translate(locale, platform === 'ios' ? 'capture.target.simulatorNamed' : 'capture.target.emulatorNamed', { name: target.device?.name || target.name })
  if (target.appName && target.appName !== target.name) return translate(locale, 'capture.target.appWindowNamed', { app: target.appName, name: target.name })
  return target.name ? translate(locale, 'capture.target.windowNamed', { name: target.name }) : translate(locale, 'capture.target.window')
}

/**
 * 画面全体・別のウインドウを録ったときに、指摘（feedback.md）へ明記する欠け。
 * 内蔵ブラウザ専用の情報（URL・要素情報・操作ログ）は、この対象では取らない。
 */
export function captureTargetGap(target: CaptureTarget, locale: SupportedLocale = getLocale()): string | null {
  if (target.kind === 'browser') return null
  return translate(locale, 'feedbackMd.captureGap', { target: captureTargetLabel(target, locale) })
}

/** 題名とアプリ名から分かるスマホの種類（端末の情報をまだ読んでいないとき） */
function deviceOfWindow(target: Extract<CaptureTarget, { kind: 'screen' | 'window' }>): CaptureDevice['platform'] | undefined {
  return target.kind === 'window' ? deviceKindOf(target.appName, target.name) : undefined
}

/**
 * feedback.md の冒頭に書く、録った対象の行（内蔵ブラウザ以外。内蔵ブラウザの URL の代わり）。
 * Agent がどのアプリ・どの端末の画面の話かを最初に分かるよう、アプリ名・ウインドウの題名・端末名・OS の版・前面のアプリと、
 * 直すもの（デスクトップアプリ・スマホアプリのソースコード）を書く
 */
export function captureTargetLines(target: CaptureTarget, locale: SupportedLocale = getLocale()): string[] {
  if (target.kind === 'browser') return []
  const lines = [`- ${translate(locale, 'feedbackMd.label.target')}: ${captureTargetLabel(target, locale)}`]
  if (target.kind !== 'window') return lines
  const platform = target.device?.platform ?? deviceOfWindow(target)
  if (platform) {
    const device = target.device
    const parts = [device?.name, device?.os].filter((p): p is string => !!p)
    if (parts.length) lines.push(`- ${translate(locale, 'feedbackMd.label.device')}: ${parts.join(' / ')}`)
    if (device?.app) lines.push(`- ${translate(locale, 'feedbackMd.label.foregroundApp')}: ${device.app}`)
    lines.push(translate(locale, 'feedbackMd.kind.mobile', { platform: platform === 'ios' ? 'iOS' : 'Android' }))
  } else {
    const engine = gameEngineOf(target.appName, target.name)
    if (engine) lines.push(translate(locale, 'feedbackMd.kind.game', { engine }))
    else if (target.appName) lines.push(translate(locale, 'feedbackMd.kind.desktop'))
  }
  return lines
}
