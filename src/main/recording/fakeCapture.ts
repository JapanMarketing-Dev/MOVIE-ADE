import { readFileSync } from 'node:fs'
import type { CaptureSourceInfo, CaptureSourceList } from '@shared/types'

/**
 * E2E だけの偽の画面・ウインドウ（ADE_E2E=1 かつ ADE_E2E_FAKE_CAPTURE に JSON のパス）。
 *
 * 画面全体・別のウインドウの録画（複数の映像・待ち受け）を、OS の画面収録に一切触れずに通すための差し替え。
 * 有効な間は desktopCapturer・osascript・screencapture を呼ばず、録画ウインドウと映したビューは
 * 本物の取り込み（chromeMediaSource: 'desktop'）の代わりに canvas の映像を録る（手元の Mac に許可の確認を出さない）。
 *
 * JSON は { "screenAccess"?: "granted" | "denied" | …, "sources": CaptureSourceInfo[] }。
 * 呼ぶたびに読み直すので、E2E は録画中にファイルを書き換えて「ウインドウが開いた・閉じた」を作れる。
 * 製品の起動（ADE_E2E が無い）では常に null で、何も変わらない
 */
export function fakeCapturePath(env: Record<string, string | undefined> = process.env): string | null {
  if (env.ADE_E2E !== '1') return null
  const path = env.ADE_E2E_FAKE_CAPTURE?.trim()
  return path ? path : null
}

const ACCESS: ReadonlySet<string> = new Set(['granted', 'denied', 'not-determined', 'restricted', 'unknown'])

/** 偽の一覧の中身を読む。壊れていれば「許可あり・何も無い」 */
export function parseFakeCapture(text: string): CaptureSourceList {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // 書きかけ・壊れた JSON（テストの書き換えの途中）は空とみなす
    return { screenAccess: 'granted', sources: [] }
  }
  const value = raw && typeof raw === 'object' ? raw as { screenAccess?: unknown; sources?: unknown } : {}
  const screenAccess = typeof value.screenAccess === 'string' && ACCESS.has(value.screenAccess) ? value.screenAccess as CaptureSourceList['screenAccess'] : 'granted'
  const sources = (Array.isArray(value.sources) ? value.sources : []).flatMap((s): CaptureSourceInfo[] => {
    if (!s || typeof s !== 'object') return []
    const source = s as Record<string, unknown>
    const id = typeof source.id === 'string' ? source.id : ''
    const kind = source.kind === 'screen' || source.kind === 'window' ? source.kind : null
    if (!kind || !/^(screen|window):[\w:-]+$/.test(id)) return []
    return [{
      id, kind, name: typeof source.name === 'string' ? source.name : '', thumbnail: '',
      ...(typeof source.appName === 'string' ? { appName: source.appName } : {}),
      ...(typeof source.bundleId === 'string' ? { bundleId: source.bundleId } : {})
    }]
  })
  return { screenAccess, sources }
}

/** 偽の一覧を読む。ファイルが無ければ「許可あり・何も無い」 */
export function readFakeCapture(path: string): CaptureSourceList {
  try {
    return parseFakeCapture(readFileSync(path, 'utf8'))
  } catch {
    // まだ書いていない（想定内）
    return { screenAccess: 'granted', sources: [] }
  }
}
