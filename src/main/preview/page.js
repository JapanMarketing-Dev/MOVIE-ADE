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

  function mermaidNodes() {
    return Array.prototype.slice.call(root.querySelectorAll('pre.mermaid'))
  }

  /** force のときは描き終えた図も描き直す（配色の切り替え）。ふだんはまだ SVG でない図だけ */
  function renderMermaid(force) {
    var nodes = mermaidNodes().filter(function (node) {
      return force || !node.querySelector('svg')
    })
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
      // 図の書き間違い（構文の誤り）は利用者の内容なので知らせない。それ以外の失敗だけを親（アプリ）へ伝え、
      // 親が Sentry へ送る（図の中身は含めず、例外の種類だけ）
      var message = err && err.message ? String(err.message) : ''
      var name = err && err.name ? String(err.name) : 'Error'
      var parse = /parse error|syntax|lexical|unknown ?diagram|no diagram type/i.test(message + ' ' + name)
      if (!parse && window.parent !== window) window.parent.postMessage({ type: 'ade-preview:render-error', kind: 'mermaid', name: name }, '*')
    })
  }

  /**
   * 外部の画像（render.ts が span.remote-image にしたもの）。既定は読まず、行き先のホストと「読み込む」ボタンを出す。
   * 押すと ?remote-images=1 を付けて読み直し、main がそのページだけ CSP で https を許す（security-3 [5]）。
   * 許されたページでは https の画像だけを <img> に戻す（http やほかのスキームは印のまま）。
   */
  function applyRemoteImages() {
    var nodes = Array.prototype.slice.call(root.querySelectorAll('span.remote-image'))
    var banner = document.getElementById('ade-preview-remote-images')
    if (root.dataset.remoteImages === 'allow') {
      nodes.forEach(function (node) {
        var src = node.dataset.remoteSrc || ''
        if (!/^https:\/\//i.test(src)) return
        var img = document.createElement('img')
        img.src = src
        img.alt = node.dataset.remoteAlt || ''
        img.referrerPolicy = 'no-referrer'
        node.replaceWith(img)
      })
      return
    }
    if (nodes.length === 0) {
      if (banner) banner.remove()
      return
    }
    var hosts = []
    nodes.forEach(function (node) {
      var host = node.dataset.remoteHost || ''
      if (host && hosts.indexOf(host) < 0) hosts.push(host)
    })
    if (!banner) {
      banner = document.createElement('div')
      banner.id = 'ade-preview-remote-images'
      banner.className = 'remote-images-banner'
      var text = document.createElement('span')
      var button = document.createElement('button')
      button.type = 'button'
      button.textContent = root.dataset.msgRemoteLoad || 'Load remote images'
      button.addEventListener('click', function () {
        var url = new URL(window.location.href)
        url.searchParams.set('remote-images', '1')
        window.location.replace(url.href)
      })
      banner.appendChild(text)
      banner.appendChild(button)
      root.parentNode.insertBefore(banner, root)
    }
    var template = root.dataset.msgRemoteBlocked || 'Remote images are not loaded: {{hosts}}'
    banner.firstChild.textContent = template.replace('{{hosts}}', hosts.join(', '))
  }

  function enqueue(task) {
    queue = queue.then(task, task)
    return queue
  }

  /**
   * 中身を差し替える。中身の同じ図は描き終えた SVG をそのまま使い回す
   * （打鍵のたびに全部の図を描き直すと、ちらつき、重くなる）。
   */
  function replace(html) {
    var drawn = {}
    mermaidNodes().forEach(function (node) {
      if (node.dataset.source !== undefined && node.querySelector('svg')) drawn[node.dataset.source] = node.innerHTML
    })
    var x = window.scrollX
    var y = window.scrollY
    // 図の高さが決まるまで文書が縮まないよう、差し替えの間だけ高さを保つ
    root.style.minHeight = root.offsetHeight + 'px'
    root.innerHTML = html
    mermaidNodes().forEach(function (node) {
      var source = node.textContent || ''
      if (!Object.prototype.hasOwnProperty.call(drawn, source)) return
      node.dataset.source = source
      node.innerHTML = drawn[source]
      node.setAttribute('data-processed', 'true')
    })
    applyRemoteImages()
    window.scrollTo(x, y)
    return renderMermaid(false).then(function () {
      root.style.minHeight = ''
      window.scrollTo(x, y)
    })
  }

  /** 保存されたファイルを取り直して差し替える */
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
        .then(replace)
        .catch(function () {
          // 読めなかった（消えた・外へ出るパスになった）ときは、今の表示のまま残す
        })
    })
  }

  window.__adePreviewRefresh = refresh
  // エディタの横に並べた iframe のとき、親（アプリ）からの指示を受ける
  //   'ade-preview:refresh'                    … 保存された。ファイルを取り直す
  //   { type: 'ade-preview:html', html }       … 編集中の内容（main が描いたもの）で差し替える
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || window.parent === window) return
    var data = event.data
    if (data === 'ade-preview:refresh') void refresh()
    else if (data && data.type === 'ade-preview:html' && typeof data.html === 'string') {
      void enqueue(function () {
        return replace(data.html)
      })
    }
  })

  // 横に並べたプレビューでは、ダブルクリックした塊の元の行へエディタを移す（「この箇所を編集」）。
  // 内蔵ブラウザで開いたとき（録画でのレビュー）は、選択の邪魔をしないよう何もしない
  if (window.parent !== window) {
    root.addEventListener('dblclick', function (event) {
      var block = event.target && event.target.closest ? event.target.closest('[data-line]') : null
      if (!block) return
      window.parent.postMessage({ type: 'ade-preview:reveal', line: Number(block.dataset.line) }, '*')
    })
  }

  media.addEventListener('change', function () {
    void enqueue(function () {
      return renderMermaid(true)
    })
  })

  // 最初の描画
  applyRemoteImages()
  enqueue(function () {
    return renderMermaid(false)
  })
})()
