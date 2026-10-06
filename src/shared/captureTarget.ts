import type { CaptureDevice, CaptureSourceInfo, CaptureSubTarget, CaptureTarget } from './types'
import { getLocale, translate, type SupportedLocale } from './i18n'
import { deviceKindOf, gameEngineOf } from './desktopApps'
import { MAX_COMPOSITE_SOURCES } from './captureComposite'

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
  const also = sanitizeAlso((raw as { also?: unknown }).also, r.sourceId)
  return { kind: r.kind, sourceId: r.sourceId, name, ...(displayId ? { displayId } : {}), ...(appName ? { appName } : {}), ...(device ? { device } : {}),
    ...(also.length ? { also } : {}) }
}

/** 同時に録るほかの対象（also）を型どおりに直す。壊れた項目・重複・最初の対象と同じもの・上限を超える分は捨てる */
function sanitizeAlso(raw: unknown, mainId: string): CaptureSubTarget[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set([mainId])
  const out: CaptureSubTarget[] = []
  for (const item of raw.slice(0, 16)) {
    if (out.length >= MAX_COMPOSITE_SOURCES - 1) break
    const r = (item && typeof item === 'object' ? item : {}) as Partial<Record<keyof CaptureSubTarget, unknown>>
    if (r.kind !== 'screen' && r.kind !== 'window') continue
    if (typeof r.sourceId !== 'string' || !r.sourceId.startsWith(`${r.kind}:`) || r.sourceId.length > 200 || seen.has(r.sourceId)) continue
    seen.add(r.sourceId)
    const name = typeof r.name === 'string' ? r.name.slice(0, 200) : ''
    const displayId = typeof r.displayId === 'string' && r.displayId.length > 0 ? r.displayId.slice(0, 64) : undefined
    const appName = r.kind === 'window' && typeof r.appName === 'string' && r.appName.length > 0 ? r.appName.slice(0, 200) : undefined
    out.push({ kind: r.kind, sourceId: r.sourceId, name, ...(displayId ? { displayId } : {}), ...(appName ? { appName } : {}) })
  }
  return out
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

/** 選んだ1件を、同時に録るほかの対象（also）の形へ直す */
function subTargetFromSource(source: CaptureSourceInfo): CaptureSubTarget {
  return { kind: source.kind, sourceId: source.id, name: source.name, ...(source.displayId ? { displayId: source.displayId } : {}),
    ...(source.kind === 'window' && source.appName ? { appName: source.appName } : {}) }
}

/** 対象に含まれる画面・ウインドウ（最初の対象と also）。内蔵ブラウザなら空 */
export function targetParts(target: CaptureTarget): CaptureSubTarget[] {
  if (target.kind === 'browser') return []
  const { also, device: _device, ...main } = target
  return [main, ...(also ?? [])]
}

/** 対象の desktopCapturer の ID（最初の対象から順に） */
export function targetSourceIds(target: CaptureTarget): string[] {
  return targetParts(target).map((part) => part.sourceId)
}

/** 選択画面でその候補を選んでいるか（複数選んだときの2つ目以降も含む） */
export function targetIncludes(target: CaptureTarget | null, sourceId: string): boolean {
  return !!target && targetSourceIds(target).includes(sourceId)
}

/**
 * 選択画面のチェック。選んでいなければ足し、選んでいれば外す。
 *   - 何も選んでいない・内蔵ブラウザなら、その1件だけにする
 *   - 最初の対象を外したら、次のものを最初にする（端末の情報は読み直す）
 *   - 上限（MAX_COMPOSITE_SOURCES）に達していれば足さない（そのまま返す）
 * @returns 新しい対象。全部外したら null
 */
export function toggleSourceInTarget(target: CaptureTarget | null, source: CaptureSourceInfo, max = MAX_COMPOSITE_SOURCES): CaptureTarget | null {
  if (!target || target.kind === 'browser') return targetFromSource(source)
  const parts = targetParts(target)
  const next = targetIncludes(target, source.id) ? parts.filter((part) => part.sourceId !== source.id)
    : parts.length >= max ? parts : [...parts, subTargetFromSource(source)]
  if (next.length === 0) return null
  if (next.length === parts.length && next.every((part, i) => part.sourceId === parts[i]!.sourceId)) return target
  return targetFromParts(next, next[0]!.sourceId === target.sourceId ? target.device : undefined)
}

/** 画面・ウインドウの並びから対象を作る（最初のものが録画の本体。ほかは also） */
export function targetFromParts(parts: readonly CaptureSubTarget[], device?: CaptureDevice): CaptureTarget | null {
  const [first, ...rest] = parts
  if (!first) return null
  return { ...first, ...(device && first.kind === 'window' ? { device } : {}), ...(rest.length ? { also: rest.map((part) => ({ ...part })) } : {}) }
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
  if (saved.also?.length) {
    // 複数選んだとき: 1つずつ探す。最初の対象が無ければ見つからない扱い。ほかは見つかったものだけ残す（呼ぶ側が欠けを確かめる）
    const { also, ...single } = saved
    const main = resolveCaptureTarget(single, sources)
    if (!main || main.kind === 'browser') return null
    const used = new Set([main.sourceId])
    const rest: CaptureSubTarget[] = []
    for (const part of also) {
      const found = resolveCaptureTarget(part, sources.filter((s) => !used.has(s.id)))
      if (!found || found.kind === 'browser') continue
      used.add(found.sourceId)
      rest.push(targetParts(found)[0]!)
    }
    return { ...main, ...(rest.length ? { also: rest } : {}) }
  }
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
  if (target.also?.length) {
    const { also, ...single } = target
    return translate(locale, 'capture.target.multiple', { first: captureTargetLabel(single, locale), n: also.length })
  }
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
  if (target.also?.length) {
    // 複数を1本の動画に並べて録った。画像のどこに何が写っているかを Agent が分かるよう、並びの順に書く
    const names = targetParts(target).map((part) => captureTargetLabel(part, locale))
    lines.push(`- ${translate(locale, 'feedbackMd.label.composite')}: ${names.join(' / ')}`)
  }
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
