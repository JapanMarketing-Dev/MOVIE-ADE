// 描画前に読む小さなスクリプト（ちらつき防止）。CSP でインラインの script を禁じているので外部ファイルにする。
// head の stylesheet より前に、defer なしで読み込む。
// サイトは黒基調の1テーマだけ。html.js は「JS が動く」印で、スクロールで現れる演出（.reveal）は JS があるときだけ隠しておく。
document.documentElement.classList.add('js')

// 旧アドレス（Pages の既定の movie-ade.pages.dev とプレビューの *.movie-ade.pages.dev）は使わない。描画の前に ferretade.dev の同じページへ移す。
// Pages は host ごとの転送を _redirects で書けず、Functions は全アクセスで動いて無料枠を使うため、ここで行う（_headers で noindex も付けている）。
if (/(^|\.)movie-ade\.pages\.dev$/.test(location.hostname)) {
  location.replace('https://ferretade.dev' + location.pathname + location.search + location.hash)
}
