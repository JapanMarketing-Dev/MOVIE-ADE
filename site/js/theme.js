// 描画前に読む小さなスクリプト（ちらつき防止）。CSP でインラインの script を禁じているので外部ファイルにする。
// head の stylesheet より前に、defer なしで読み込む。
// サイトは黒基調の1テーマだけ。html.js は「JS が動く」印で、スクロールで現れる演出（.reveal）は JS があるときだけ隠しておく。
document.documentElement.classList.add('js')
