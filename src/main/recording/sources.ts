import { BrowserWindow, desktopCapturer, screen, shell, systemPreferences } from 'electron'
import type { CaptureSourceInfo, CaptureSourceList } from '@shared/types'
import { t } from '@shared/i18n'
import { reportHandled } from '@shared/report'

/**
 * 画面全体・別のウインドウの録画対象（REC-2 の拡張 / 設計9章）。
 *
 * desktopCapturer で候補を列挙し、選択画面用にサムネイルを付ける。
 * 内蔵ブラウザのタブ録画と違い、macOS では「画面収録」の許可が要る。
 * 許可が無いと、候補は自アプリのウインドウと壁紙だけの画面になり、録画の映像も空になる。
 */

/**
 * 画面収録の許可。確認するのは macOS だけで、Windows・Linux（X11 / Wayland）は常に 'granted'。
 * Orca由来: ~/bench/orca/src/main/browser/browser-media-access.ts の hasSystemMediaAccess（MIT）。
 * Orca はマイク・カメラを見ているが、同じ考え方で 'screen' を見る。
 */
export function screenAccess(): CaptureSourceList['screenAccess'] {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch (err) {
    reportHandled(err, { area: 'recording', op: 'read screen access' })
    return 'unknown'
  }
}

/**
 * システム設定の「画面収録」を開く。
 * Orca由来: ~/bench/orca/src/main/ipc/developer-permissions.ts の screen の URL（MIT）。
 *
 * 画面収録の許可が要るのは macOS だけ。Windows は許可が要らず、Linux は X11 ならそのまま、
 * Wayland なら録画を始めるときに OS（PipeWire のポータル）が選択ダイアログを出す。
 * どちらも開く設定が無いので何もしない（screenAccess が 'granted' を返すので案内も出ない）。
 */
export async function openScreenSettings(): Promise<void> {
  if (process.platform !== 'darwin') return
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
}

/**
 * 録画できる画面・ウインドウの一覧。
 *
 * 自アプリのウインドウ（ADE-movie 本体・録画用の非表示ウインドウ）は出さない。
 * 内蔵ブラウザを録るなら「内蔵ブラウザ」を選べばよく、本体を録ると自分の録画ピルまで写るため。
 *
 * @param thumbnail サムネイルの大きさ。0×0 なら作らない（録画開始時の存在確認用。速い）
 */
export async function listCaptureSources(
  thumbnail: { width: number; height: number } = { width: 320, height: 200 }
): Promise<CaptureSourceInfo[]> {
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()))
  const withThumbnail = thumbnail.width > 0 && thumbnail.height > 0
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: thumbnail,
    fetchWindowIcons: withThumbnail
  })
  const displays = screen.getAllDisplays()
  const primaryId = String(screen.getPrimaryDisplay().id)

  return sources
    .filter((source) => !own.has(source.id))
    .map((source): CaptureSourceInfo => {
      const kind = source.id.startsWith('screen:') ? 'screen' : 'window'
      const displayId = source.display_id || undefined
      return {
        id: source.id,
        kind,
        name: kind === 'screen' ? screenName(displayId, displays, primaryId, source.name) : source.name || t('recording.source.untitledWindow'),
        ...(displayId ? { displayId } : {}),
        thumbnail: withThumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : '',
        ...(source.appIcon && !source.appIcon.isEmpty() ? { appIcon: source.appIcon.toDataURL() } : {})
      }
    })
}

/** 画面の名前。OSの名前（Entire Screen など）は区別が付かないので、番号と大きさにする */
function screenName(displayId: string | undefined, displays: Electron.Display[], primaryId: string, fallback: string): string {
  const index = displays.findIndex((d) => String(d.id) === displayId)
  if (index < 0) return fallback || t('recording.source.screen')
  const display = displays[index]!
  const params = { n: index + 1, width: display.size.width, height: display.size.height }
  return String(display.id) === primaryId ? t('recording.source.screenNumberedMain', params) : t('recording.source.screenNumbered', params)
}
