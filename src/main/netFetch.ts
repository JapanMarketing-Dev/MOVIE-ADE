/**
 * main からの外向き HTTP（文字起こし・整理の API）。
 *
 * Node の fetch は OS のプロキシ設定も証明書ストアも見ないので、社内プロキシや社内 CA の下では
 * 更新確認・使用量（net.fetch）は通るのに文字起こしだけ失敗する（Orca #22456 #19789 #1378）。
 * Electron の main では net.fetch（Chromium のネットワーク）を使う。単体テスト（Electron の外）では Node の fetch。
 * Chromium が危ないとして断るポート（6000 など）のローカルのサーバーは、Node の fetch で送り直す。
 * redirect: 'manual' は net.fetch が例外にするので、使うところ（モデルの取得）はここを通さない。
 *
 * ここを通るのは、キー（Authorization・x-api-key・設定のヘッダー）と録音・指摘の中身を送る依頼。キーを送ってよい接続元は
 * 最初の URL で確かめている（credentialOrigin.ts）ので、リダイレクトは既定で追わない（security-7 [10]。
 * 追うと、確かめていない別の接続元へ同じヘッダーと本文が送られる）。リダイレクトが来たら例外になる
 */
export async function mainFetch(url: string, init?: RequestInit): Promise<Response> {
  init = { ...init, redirect: init?.redirect ?? 'error' }
  if (!process.versions.electron || process.type !== 'browser') return fetch(url, init)
  const { net } = await import('electron')
  try {
    return await net.fetch(url, init)
  } catch (err) {
    if (err instanceof Error && err.message.includes('ERR_UNSAFE_PORT')) return fetch(url, init)
    throw err
  }
}
