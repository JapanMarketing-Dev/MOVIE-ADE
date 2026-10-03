// 描画前にテーマを当てる（ちらつき防止）。CSP でインラインの script を禁じているので外部ファイルにする。
// head の stylesheet より前に、defer なしで読み込む。
try {
  var t = localStorage.getItem('ade-site-theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) {}
