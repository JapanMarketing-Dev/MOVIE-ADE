import { t } from './i18n'

/**
 * 利用者に見せるための想定内のエラー（「プロジェクトが見つかりません」「録画中は切り替えできません」など）。
 *
 * 文は t() で作った利用者向けのもの。不具合ではないので、クラッシュレポート（Sentry）には送らない
 * （src/shared/telemetry.ts の wrapIpcHandler が見分ける）。
 * renderer が `Error invoking remote method '…': Error: 本文` から本文を取り出す形（lib/errors.ts）を変えないよう、
 * name は Error のままにする。
 */
export class UserFacingError extends Error {
  readonly userFacing = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'Error'
  }
}

/** UserFacingError か。別の読み込み（チャンク）で作られたものも印で見分ける */
export function isUserFacingError(err: unknown): boolean {
  return err instanceof UserFacingError || (typeof err === 'object' && err !== null && (err as { userFacing?: unknown }).userFacing === true)
}

/**
 * ファイル操作の想定内の OS エラー（権限・空き容量・フォルダが無い）を、利用者向けの文の UserFacingError にする
 * （cause に元のエラー）。英語のエラーとパスを画面に出さず、不具合ではないので Sentry にも送らない。
 * それ以外（EIO など想定外のコード、コードの無い例外）はそのまま返す（今までどおり送る）。
 */
export function toUserFacingFileError(err: unknown): unknown {
  if (isStaleChunkError(err)) return new UserFacingError(t('errors.appFilesReplaced'), { cause: err })
  const message = fileErrorMessage((err as { code?: unknown } | null)?.code)
  return message ? new UserFacingError(message, { cause: err }) : err
}

/** ビルドの分割ファイル（out/main/chunks/〜.js など）が見つからないときの文。CJS の require と ESM の import の両方 */
export const STALE_CHUNK_MESSAGE = /Cannot find (?:module|package) ['"][^'"]*chunks[\\/][^'"]+\.[cm]?js['"]/

/**
 * 起動中にアプリのファイル（out/ や配布版の中身）が入れ替わり、遅延 import の分割ファイルが無くなったか（Sentry FERRET-X）。
 * dev で誰かが作業ツリーの out/ に build し直すと、chunk の名前（ハッシュ）が変わって起きる。不具合ではなく再起動で直る
 */
export function isStaleChunkError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  if (e?.code !== 'MODULE_NOT_FOUND' && e?.code !== 'ERR_MODULE_NOT_FOUND') return false
  return STALE_CHUNK_MESSAGE.test(String(e.message ?? ''))
}

function fileErrorMessage(code: unknown): string | undefined {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return t('errors.saveNoPermission')
    case 'ENOSPC':
      return t('errors.saveNoSpace')
    case 'ENOENT':
    case 'ENOTDIR':
      return t('errors.saveFolderMissing')
    default:
      return undefined
  }
}
