/*
 * プレビューのページ（ade-preview://）で動くスクリプト。内蔵ブラウザと、エディタの横並びの iframe で使う。
 *
 * - ```mermaid のブロック（<pre class="mermaid">）を Mermaid で SVG にする
 * - 配色（prefers-color-scheme）が変わったら、図を描き直す
 * - ファイルが保存されたら、ページを読み直さずに中身だけ差し替える（スクロール位置を保つ）
 *     内蔵ブラウザ … main が executeJavaScript で window.__adePreviewRefresh() を呼ぶ
 *     iframe       … 親（アプリ）が postMessage('ade-preview:refresh') を送る
 *   ページごと読み直すと、録画中のペンと文字の書き込み（注入スクリプト）まで消えてしまうため。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/MermaidBlock.tsx・mermaid-config.ts（MIT）
 *   securityLevel: 'strict'、描画は1本の列に並べて同時に走らせない、失敗しても元の文を残して他を壊さない。
 */
;(function () {
  'use strict'
  var root = document.getElementById('ade-preview')
  if (!root) return
  var media = window.matchMedia('(prefers-color-scheme: dark)')
  var queue = Promise.resolve()

  var mermaidLoading = null
  /** Mermaid は大きいので、図があるときだけ読み込む */
  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid)
    mermaidLoading =
      mermaidLoading ||
      new Promise(function (resolve, reject) {
        var script = document.createElement('script')
        script.src = 'ade-preview://assets/mermaid.js'
        script.onload = function () {
          resolve(window.mermaid)
        }
        script.onerror = function () {
          mermaidLoading = null
          reject(new Error(root.dataset.msgMermaidLoad || "Couldn't load Mermaid"))
        }
        document.head.appendChild(script)
      })
    return mermaidLoading
  }

  function renderMermaid() {
    var nodes = Array.prototype.slice.call(root.querySelectorAll('pre.mermaid'))
    if (nodes.length === 0) return Promise.resolve()
    return loadMermaid().then(function (mermaid) {
      return drawMermaid(mermaid, nodes)
    }, function () {})
  }

  function drawMermaid(mermaid, nodes) {
    nodes.forEach(function (node) {
      // 描き直せるよう、元の文を data-source に持っておく（SVG にすると文が消えるため）
      if (node.dataset.source === undefined) node.dataset.source = node.textContent || ''
      node.textContent = node.dataset.source
      node.removeAttribute('data-processed')
      var error = node.previousElementSibling
      if (error && error.classList.contains('mermaid-error')) error.remove()
    })
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: media.matches ? 'dark' : 'default'
    })
    return mermaid.run({ nodes: nodes, suppressErrors: false }).catch(function (err) {
      // どの図が失敗したかは分からないことがあるので、描けなかった図に理由を付ける
      nodes.forEach(function (node) {
        if (node.querySelector('svg')) return
        var note = document.createElement('div')
        note.className = 'mermaid-error'
        // 文は main が画面の言語で data-msg-diagram-failed に入れて渡す（{{error}} を理由に置き換える）
        var template = root.dataset.msgDiagramFailed || "Couldn't render the diagram: {{error}}"
        note.textContent = template.replace('{{error}}', err && err.message ? err.message : String(err))
        node.parentNode.insertBefore(note, node)
      })
    })
  }

  function enqueue(task) {
    queue = queue.then(task, task)
    return queue
  }

  function refresh() {
    return enqueue(function () {
      var url = new URL(window.location.href)
      url.search = '?fragment=1'
      url.hash = ''
      return fetch(url.href, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error(String(res.status))
          return res.text()
        })
        .then(function (html) {
          var x = window.scrollX
          var y = window.scrollY
          // 図の高さが決まるまで文書が縮まないよう、差し替えの間だけ高さを保つ
          root.style.minHeight = root.offsetHeight + 'px'
          root.innerHTML = html
          return renderMermaid().then(function () {
            root.style.minHeight = ''
            window.scrollTo(x, y)
          })
        })
        .catch(function () {
          // 読めなかった（消えた・外へ出るパスになった）ときは、今の表示のまま残す
        })
    })
  }

  window.__adePreviewRefresh = refresh
  window.addEventListener('message', function (event) {
    if (event.source === window.parent && event.data === 'ade-preview:refresh') void refresh()
  })
  media.addEventListener('change', function () {
    void enqueue(renderMermaid)
  })

  // 最初の描画
  enqueue(renderMermaid)
})()
