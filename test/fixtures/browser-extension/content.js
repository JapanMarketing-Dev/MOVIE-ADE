// E2E の題材の拡張機能（e2e/browser-extensions.spec.ts）。開いたページに目に見える印を足す
;(function () {
  if (document.getElementById('acme-ext-marker')) return
  var marker = document.createElement('div')
  marker.id = 'acme-ext-marker'
  marker.textContent = 'Acme Marker'
  marker.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:4px 8px;background:#1565c0;color:#fff;font:12px sans-serif'
  document.documentElement.appendChild(marker)
})()
