/**
 * 相手（ログイン無し）が開く画面の器。中身は workers/feedback-share/client（React。アプリのフィードバックの帯と書き込みの部品を共有する）を
 * scripts/build-share-page.mjs でまとめた generated.ts の JS と CSS（外の CDN は使わない。CSP は script-src 'self'）。
 */
export const SHARE_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<title>Ferret feedback</title>
<link rel="stylesheet" href="/assets/share.css">
<script src="/assets/share.js" defer></script>
</head>
<body>
<div id="root"></div>
<noscript>JavaScript is required.</noscript>
</body>
</html>
`
