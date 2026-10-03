import type { CaptureSourceInfo, CaptureTarget } from './types'
import { getLocale, translate, type SupportedLocale } from './i18n'

/**
 * 録画の対象（内蔵ブラウザ／画面全体／別のウインドウ）の扱い。
 * Electron に依存しない純粋な処理だけを置く（main・renderer・単体テストで共用）。
 */

export const BROWSER_TARGET: CaptureTarget = { kind: 'browser' }

/** 設定ファイルから読んだ値を型どおりに直す。壊れていれば undefined（＝内蔵ブラウザ） */
export function sanitizeCaptureTarget(raw: unknown): CaptureTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<Record<'kind' | 'sourceId' | 'name' | 'displayId', unknown>>
  if (r.kind === 'browser') return { kind: 'browser' }
  if (r.kind !== 'screen' && r.kind !== 'window') return undefined
  if (typeof r.sourceId !== 'string' || !r.sourceId.startsWith(`${r.kind}:`)) return undefined
  const name = typeof r.name === 'string' ? r.name.slice(0, 200) : ''
  const displayId = typeof r.displayId === 'string' && r.displayId.length > 0 ? r.displayId : undefined
  return { kind: r.kind, sourceId: r.sourceId, name, ...(displayId ? { displayId } : {}) }
}

/** 選択画面で選んだ1件を、覚えておく形へ直す */
export function targetFromSource(source: CaptureSourceInfo): CaptureTarget {
  return { kind: source.kind, sourceId: source.id, name: source.name, ...(source.displayId ? { displayId: source.displayId } : {}) }
}

/**
 * 覚えていた対象を、いまの候補の中から探す。
 *
 * desktopCapturer の ID はアプリや OS の再起動で変わる。ID で見つからなければ、
 * 画面は displayId、ウインドウは名前（タイトル）が同じものを使う。
 * 名前が同じウインドウが複数あるときは取り違えないよう、見つからない扱いにする。
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
  if (saved.kind === 'window' && saved.name) {
    const byName = sameKind.filter((s) => s.name === saved.name)
    if (byName.length === 1) return targetFromSource(byName[0]!)
  }
  return null
}

/** 画面やログに出す短い名前（例「画面全体（画面 1）」「ウインドウ「Figma」」） */
export function captureTargetLabel(target: CaptureTarget, locale: SupportedLocale = getLocale()): string {
  if (target.kind === 'browser') return translate(locale, 'capture.target.browser')
  if (target.kind === 'screen') return target.name ? translate(locale, 'capture.target.screenNamed', { name: target.name }) : translate(locale, 'capture.target.screen')
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
