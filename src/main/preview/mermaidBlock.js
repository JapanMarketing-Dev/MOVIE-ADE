/*
 * Markdown の編集画面（リッチな編集）の ```mermaid の図を描くページ（ade-preview://assets/mermaid-block.html）で動くスクリプト。
 * 親（アプリの renderer。src/renderer/editor/richMarkdown/mermaidBlock.ts）が、隠した sandbox の iframe を1つだけ置いて使い回す。
 * Mermaid を動かすのはこの隔離したページの中だけ。親は返った SVG を <img>（SVG の画像。スクリプトも外部の読み込みも動かない）で出す。
 *
 * 受け取る（送り主が親のときだけ。1つずつ順に描く）:
 *   { type: 'ade-mermaid:render', id, source, theme: 'light' | 'dark' }
 * 送る:
 *   { type: 'ade-mermaid:ready' }                                  … 読み込みが終わった
 *   { type: 'ade-mermaid:rendered', id, ok: true, svg }            … 描けた（大きさは width / height の属性に入れてある）
 *   { type: 'ade-mermaid:rendered', id, ok: false, error }         … 書き間違いなど（error は文。親が文字として出す）
 *
 * securityLevel: 'strict'（プレビューのページ page.js と同じ）。
 */
;(function () {
  'use strict'
  var root = document.getElementById('ade-mermaid')
  if (!root || window.parent === window) return
  var queue = Promise.resolve()
  var mermaidLoading = null
  var seq = 0

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid)
    mermaidLoading =
      mermaidLoading ||
      new Promise(function (resolve, reject) {
        var script = document.createElement('script')
        // 版付きの URL（main がキャッシュしてよいと返す）。無ければ版なし
        script.src = root.dataset.mermaidSrc || 'ade-preview://assets/mermaid.js'
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

  function post(message) {
    window.parent.postMessage(message, '*')
  }

  /**
   * 画像として出せるよう、SVG に実際の大きさ（viewBox の幅と高さ）を width / height で入れる。
   * Mermaid は既定で width="100%" と max-width の style を付けるので、そのままだと画像の大きさが決まらない
   */
  function sized(svgText) {
    var holder = document.createElement('div')
    holder.innerHTML = svgText
    var svg = holder.querySelector('svg')
    if (!svg) return svgText
    var box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
    if (box.length === 4 && box[2] > 0 && box[3] > 0) {
      svg.setAttribute('width', String(Math.ceil(box[2])))
      svg.setAttribute('height', String(Math.ceil(box[3])))
      svg.style.maxWidth = ''
    }
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    return new XMLSerializer().serializeToString(svg)
  }

  function cleanup() {
    // Mermaid が書き間違いのときに body の末尾に残す描きかけの要素を消す
    Array.prototype.slice.call(document.querySelectorAll('body > [id^="dade-mermaid-"], body > svg[id^="ade-mermaid-"]')).forEach(function (node) {
      node.remove()
    })
    root.textContent = ''
  }

  function draw(data) {
    var theme = data.theme === 'dark' ? 'dark' : 'default'
    return loadMermaid().then(function (mermaid) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme })
      seq += 1
      return mermaid.render('ade-mermaid-' + seq, data.source, root).then(function (result) {
        var svg = sized(result.svg)
        cleanup()
        post({ type: 'ade-mermaid:rendered', id: data.id, ok: true, svg: svg })
      })
    }).catch(function (err) {
      cleanup()
      post({ type: 'ade-mermaid:rendered', id: data.id, ok: false, error: err && err.message ? String(err.message) : String(err) })
    })
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || data.type !== 'ade-mermaid:render' || typeof data.source !== 'string' || typeof data.id !== 'number') return
    queue = queue.then(function () {
      return draw(data)
    }, function () {
      return draw(data)
    })
  })

  post({ type: 'ade-mermaid:ready' })
})()
