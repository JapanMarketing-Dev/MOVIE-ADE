/**
 * main からの外向き HTTP（文字起こし・整理の API）。
 *
 * Node の fetch は OS のプロキシ設定も証明書ストアも見ないので、社内プロキシや社内 CA の下では
 * 更新確認・使用量（net.fetch）は通るのに文字起こしだけ失敗する（Orca #22456 #19789 #1378）。
 * Electron の main では net.fetch（Chromium のネットワーク）を使う。単体テスト（Electron の外）では Node の fetch。
 * Chromium が危ないとして断るポート（6000 など）のローカルのサーバーは、Node の fetch で送り直す。
 * redirect: 'manual' は net.fetch が例外にするので、使うところ（モデルの取得）はここを通さない。
 */
export async function mainFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!process.versions.electron || process.type !== 'browser') return fetch(url, init)
  const { net } = await import('electron')
  try {
    return await net.fetch(url, init)
  } catch (err) {
    if (err instanceof Error && err.message.includes('ERR_UNSAFE_PORT')) return fetch(url, init)
    throw err
  }
}
