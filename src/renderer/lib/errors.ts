/**
 * 例外から、利用者に見せる文だけを取り出す。
 *
 * Electron は main で投げた例外を
 * `Error invoking remote method 'review:load': Error: 本文` の形で包んで返す。
 * チャネル名や `Error:` を画面に出さないよう、本文だけにする。
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(/^(?:[A-Za-z]*Error: )+/, '')
    .trim()
}
