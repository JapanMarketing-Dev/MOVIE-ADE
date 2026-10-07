/**
 * 相手（ログイン無し）が開く注釈の画面。Worker がそのまま配る静的な HTML・CSS・JS（外の CDN は使わない。CSP は script-src 'self'）。
 *
 * - 共有の中身は /v1/public/<id> から読み、文字はすべて textContent で出す（innerHTML を使わない）
 * - 静止画の上でピン・枠・ペンで注釈して文を書き、/v1/public/<id>/comments へ送る。名前は任意で、この端末に覚える
 * - 「ライブ」では元のページを iframe で開いて触れる。注釈の層をオンにするとその上にピンを打てる（見ている URL を一緒に送る）。
 *   iframe を拒むサイトは「新しいタブで開く」で見て、文だけ（と URL）を送る
 * - 表示は日本語か英語（navigator.language）
 *
 * JS は文字列で持つので、中ではテンプレートリテラル（バッククォート）を使わない。
 */

export const SHARE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Ferret feedback</title>
<link rel="stylesheet" href="/assets/share.css">
<script src="/assets/share.js" defer></script>
</head>
<body>
<header class="bar">
  <div class="brand"><span class="logo" aria-hidden="true"></span><span id="share-title" class="title"></span></div>
  <label class="name"><span id="name-label"></span><input id="name" maxlength="50" autocomplete="nickname"></label>
</header>
<main id="app" class="app" hidden>
  <nav id="pages" class="pages" aria-label="pages"></nav>
  <section class="stage">
    <div class="tools" role="toolbar">
      <div class="group" id="modes"></div>
      <div class="group" id="views"></div>
      <a id="open-tab" class="link" target="_blank" rel="noopener noreferrer"></a>
    </div>
    <div id="live-hint" class="hint" hidden></div>
    <div id="canvas" class="canvas">
      <img id="shot" alt="" draggable="false">
      <iframe id="live" title="live" hidden referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
      <svg id="overlay" class="overlay"></svg>
    </div>
  </section>
  <aside class="side">
    <form id="composer" class="composer" autocomplete="off">
      <div id="shape-note" class="muted"></div>
      <textarea id="text" rows="4" maxlength="2000" required></textarea>
      <input id="live-url" type="url" hidden>
      <input id="website" name="website" class="hp" tabindex="-1" aria-hidden="true">
      <div class="row"><button id="clear-shape" type="button" class="ghost"></button><button id="send" type="submit"></button></div>
      <div id="status" class="status" role="status"></div>
    </form>
    <h2 id="list-title"></h2>
    <ol id="list" class="list"></ol>
  </aside>
</main>
<div id="message" class="message"></div>
<footer class="foot"><span id="foot"></span></footer>
</body>
</html>
`

export const SHARE_CSS = String.raw`
:root { --bg: #f7f7f8; --panel: #fff; --ink: #18181b; --muted: #6b6b76; --line: #e4e4e7; --accent: #e5484d; --accent-ink: #fff; --focus: #3b82f6; }
@media (prefers-color-scheme: dark) { :root { --bg: #111113; --panel: #18181b; --ink: #ededef; --muted: #a1a1aa; --line: #2e2e33; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.logo { width: 18px; height: 18px; border-radius: 5px; background: var(--accent); flex: none; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.name input { width: 140px; }
input, textarea { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { width: 100%; resize: vertical; }
input:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button[aria-pressed="true"] { background: var(--ink); color: var(--panel); border-color: var(--ink); }
button[type="submit"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.ghost { background: transparent; }
button:disabled { opacity: .5; cursor: default; }
.app { display: grid; grid-template-columns: 180px minmax(0, 1fr) 320px; height: calc(100% - 90px); }
.pages { border-right: 1px solid var(--line); overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.pages button { text-align: left; display: block; width: 100%; padding: 6px; }
.pages img { display: block; width: 100%; border-radius: 4px; border: 1px solid var(--line); margin-bottom: 4px; }
.pages .page-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.stage { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
.group { display: inline-flex; gap: 4px; }
.link { color: var(--focus); font-size: 12px; margin-left: auto; }
.hint { padding: 6px 12px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); }
.canvas { position: relative; overflow: auto; flex: 1; padding: 12px; }
#shot { display: block; max-width: 100%; height: auto; margin: 0 auto; user-select: none; -webkit-user-select: none; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
#live { display: block; width: 100%; height: 100%; min-height: 70vh; border: 1px solid var(--line); background: #fff; }
.overlay { position: absolute; left: 0; top: 0; touch-action: none; }
.overlay.passive { pointer-events: none; }
.overlay .shape { fill: rgba(229,72,77,.12); stroke: var(--accent); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.overlay .pen { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.overlay .other { opacity: .55; }
.overlay .badge { fill: var(--accent); }
.overlay .badge-text { fill: #fff; font-size: 12px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.side { border-left: 1px solid var(--line); overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--panel); }
.composer { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; justify-content: flex-end; gap: 8px; }
.muted { color: var(--muted); font-size: 12px; }
.status { font-size: 12px; min-height: 1em; }
.status.error { color: var(--accent); }
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
h2 { font-size: 13px; margin: 8px 0 0; }
.list { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
.list li { font-size: 13px; }
.list .who { color: var(--muted); font-size: 12px; display: block; }
.list .text { white-space: pre-wrap; word-break: break-word; }
.message { padding: 40px 16px; text-align: center; color: var(--muted); }
.message:empty { display: none; }
.foot { padding: 6px 16px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--line); background: var(--panel); }
@media (max-width: 820px) {
  .app { display: flex; flex-direction: column; height: auto; }
  .pages { flex-direction: row; border-right: 0; border-bottom: 1px solid var(--line); }
  .pages button { width: 120px; flex: none; }
  .side { border-left: 0; border-top: 1px solid var(--line); }
  .canvas { padding: 8px; }
  .name input { width: 110px; }
}
`

export const SHARE_JS = String.raw`(function () {
  'use strict'
  var STR = {
    ja: {
      name: '名前（任意）', pin: 'ピン', rect: '枠', pen: 'ペン', still: '静止画', live: 'ライブで操作', annotateLive: 'ライブに注釈', openTab: '新しいタブで開く',
      liveHint: '元のページを開いています。触って確かめ、「ライブに注釈」をオンにするとピンを打てます。表示されないときは「新しいタブで開く」で見て、文で送ってください。',
      liveUrl: '見ているページの URL', placeholder: '気になるところ・直してほしいことを書いてください', send: '送る', clearShape: '注釈を消す',
      noShape: '注釈なし（画像の上でピン・枠・ペンを使うと場所を示せます）', withPin: 'ピンで場所を示しています', withRect: '枠で場所を示しています', withPen: 'ペンで場所を示しています',
      sent: '送りました。ありがとうございます。', sending: '送っています…', list: '送られた指摘', yours: 'あなた', anonymous: '名前なし',
      notFound: 'この共有は見つかりません。リンクを確かめてください。', gone: 'この共有は期限が切れました。', failed: '送れませんでした。時間をおいてもう一度試してください。',
      rateLimited: '送信が多すぎます。少し待ってから送ってください。', tooLong: '長すぎます。短くしてください。', full: 'この共有は受け付けられる数に達しました。',
      expires: '期限', foot: 'ログインは要りません。送った内容と名前は、この共有を作った人だけが見ます（作った人が許していれば、ほかの人にも見えます）。', loading: '読み込んでいます…'
    },
    en: {
      name: 'Name (optional)', pin: 'Pin', rect: 'Box', pen: 'Pen', still: 'Screenshot', live: 'Live page', annotateLive: 'Annotate live', openTab: 'Open in new tab',
      liveHint: 'This is the original page. Use it, then turn on "Annotate live" to drop a pin. If it does not load, open it in a new tab and send your note as text.',
      liveUrl: 'URL you are looking at', placeholder: 'What should change here?', send: 'Send', clearShape: 'Clear mark',
      noShape: 'No mark (use pin, box or pen on the image to point at a spot)', withPin: 'Pointing with a pin', withRect: 'Pointing with a box', withPen: 'Pointing with a pen',
      sent: 'Sent. Thank you!', sending: 'Sending…', list: 'Feedback', yours: 'You', anonymous: 'Anonymous',
      notFound: 'This share link was not found. Check the link.', gone: 'This share link has expired.', failed: 'Could not send. Please try again later.',
      rateLimited: 'Too many messages. Please wait a little and try again.', tooLong: 'Too long. Please shorten it.', full: 'This share is no longer accepting feedback.',
      expires: 'Expires', foot: 'No sign-in needed. Only the person who shared this link sees your note and name (and other reviewers, if they allowed it).', loading: 'Loading…'
    }
  }
  var lang = (navigator.language || 'en').toLowerCase().indexOf('ja') === 0 ? 'ja' : 'en'
  var T = STR[lang]
  document.documentElement.lang = lang
  var NAME_KEY = 'ferret-share-name'
  var SVG = 'http://www.w3.org/2000/svg'
  var shareId = (location.pathname.match(/^\/s\/([0-9a-f]{32})\/?$/) || [])[1]
  var $ = function (id) { return document.getElementById(id) }
  var state = { share: null, page: null, mode: 'pin', view: 'still', liveAnnotate: false, shape: null, drawing: null, mine: [] }

  function text(el, value) { el.textContent = value == null ? '' : String(value) }
  function storageGet(key) { try { return localStorage.getItem(key) || '' } catch (e) { return '' } }
  function storageSet(key, value) { try { localStorage.setItem(key, value) } catch (e) { /* 使えない環境（想定内） */ } }
  function button(label, pressed, onClick) {
    var b = document.createElement('button')
    b.type = 'button'
    text(b, label)
    if (pressed !== null) b.setAttribute('aria-pressed', pressed ? 'true' : 'false')
    b.addEventListener('click', onClick)
    return b
  }
  function message(value) { text($('message'), value); $('app').hidden = !!value }
  function status(value, isError) { var s = $('status'); text(s, value); s.className = 'status' + (isError ? ' error' : '') }
  function imageUrl(page) { return '/v1/public/' + shareId + '/pages/' + page.id + '.' + page.ext }

  function init() {
    text($('name-label'), T.name)
    $('name').value = storageGet(NAME_KEY)
    $('name').addEventListener('change', function () { storageSet(NAME_KEY, $('name').value.trim()) })
    $('text').placeholder = T.placeholder
    $('live-url').placeholder = T.liveUrl
    $('live-url').setAttribute('aria-label', T.liveUrl)
    text($('send'), T.send)
    text($('clear-shape'), T.clearShape)
    text($('list-title'), T.list)
    text($('foot'), T.foot)
    text($('open-tab'), T.openTab)
    $('clear-shape').addEventListener('click', function () { state.shape = null; render() })
    $('composer').addEventListener('submit', function (e) { e.preventDefault(); send() })
    $('shot').addEventListener('load', render)
    window.addEventListener('resize', render)
    bindDrawing()
    if (!shareId) { message(T.notFound); return }
    message(T.loading)
    fetch('/v1/public/' + shareId, { credentials: 'omit' }).then(function (res) {
      return res.json().then(function (body) { return { res: res, body: body } })
    }).then(function (r) {
      if (!r.res.ok || !r.body.ok) { message(r.body && r.body.code === 'gone' ? T.gone : T.notFound); return }
      state.share = r.body.share
      text($('share-title'), state.share.title || 'Ferret')
      document.title = (state.share.title ? state.share.title + ' – ' : '') + 'Ferret feedback'
      message('')
      renderPages()
      if (state.share.pages.length) selectPage(state.share.pages[0])
    }).catch(function () { message(T.failed) })
  }

  function renderPages() {
    var nav = $('pages')
    nav.replaceChildren()
    state.share.pages.forEach(function (page) {
      var b = button('', state.page && state.page.id === page.id, function () { selectPage(page) })
      var img = document.createElement('img')
      img.src = imageUrl(page)
      img.alt = ''
      img.loading = 'lazy'
      var title = document.createElement('span')
      title.className = 'page-title'
      text(title, page.title || page.url)
      b.title = page.url
      b.replaceChildren(img, title)
      nav.appendChild(b)
    })
  }

  function selectPage(page) {
    state.page = page
    state.shape = null
    state.view = 'still'
    state.liveAnnotate = false
    $('shot').src = imageUrl(page)
    $('open-tab').href = page.url
    $('live-url').value = page.url
    renderPages()
    renderTools()
    renderList()
    render()
  }

  function renderTools() {
    var modes = $('modes')
    modes.replaceChildren()
    var live = state.view === 'live'
    var kinds = live ? ['pin'] : ['pin', 'rect', 'pen']
    if (live && state.mode !== 'pin') state.mode = 'pin'
    kinds.forEach(function (kind) {
      modes.appendChild(button(T[kind], state.mode === kind, function () { state.mode = kind; renderTools() }))
    })
    var views = $('views')
    views.replaceChildren(
      button(T.still, !live, function () { setView('still') }),
      button(T.live, live, function () { setView('live') })
    )
    if (live) views.appendChild(button(T.annotateLive, state.liveAnnotate, function () { state.liveAnnotate = !state.liveAnnotate; renderTools(); render() }))
    var hint = $('live-hint')
    hint.hidden = !live
    text(hint, T.liveHint)
    $('live-url').hidden = !live
  }

  function setView(view) {
    state.view = view
    state.shape = null
    var live = view === 'live'
    $('shot').hidden = live
    var frame = $('live')
    frame.hidden = !live
    if (live && frame.getAttribute('src') !== state.page.url) frame.src = state.page.url
    renderTools()
    render()
  }

  /* ── 注釈の層 ─────────────────────────── */

  function surface() { return state.view === 'live' ? $('live') : $('shot') }

  function bindDrawing() {
    var overlay = $('overlay')
    function point(e) {
      var r = overlay.getBoundingClientRect()
      if (!r.width || !r.height) return null
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]
    }
    overlay.addEventListener('pointerdown', function (e) {
      if (!state.page) return
      var p = point(e)
      if (!p) return
      e.preventDefault()
      overlay.setPointerCapture(e.pointerId)
      if (state.mode === 'pin') { state.shape = { kind: 'pin', x: p[0], y: p[1] }; render(); $('text').focus(); return }
      state.drawing = { start: p, points: [p] }
    })
    overlay.addEventListener('pointermove', function (e) {
      if (!state.drawing) return
      var p = point(e)
      if (!p) return
      var d = state.drawing
      if (state.mode === 'rect') {
        var x = Math.min(d.start[0], p[0]), y = Math.min(d.start[1], p[1])
        state.shape = { kind: 'rect', x: x, y: y, w: Math.abs(p[0] - d.start[0]), h: Math.abs(p[1] - d.start[1]) }
      } else {
        var last = d.points[d.points.length - 1]
        if (Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) > 0.004 && d.points.length < 200) d.points.push(p)
        state.shape = { kind: 'pen', points: d.points.slice() }
      }
      render()
    })
    function end() {
      if (!state.drawing) return
      state.drawing = null
      var s = state.shape
      if (s && s.kind === 'rect' && (s.w < 0.01 || s.h < 0.01)) state.shape = null
      if (s && s.kind === 'pen' && s.points.length < 2) state.shape = null
      render()
      if (state.shape) $('text').focus()
    }
    overlay.addEventListener('pointerup', end)
    overlay.addEventListener('pointercancel', end)
  }

  function el(name, attrs) {
    var node = document.createElementNS(SVG, name)
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, String(attrs[k])) })
    return node
  }

  function drawShape(svg, shape, w, h, cls, label) {
    var cx = 0, cy = 0
    if (shape.kind === 'pin') {
      cx = shape.x * w; cy = shape.y * h
      svg.appendChild(el('circle', { cx: cx, cy: cy, r: 14, 'class': 'shape ' + cls }))
    } else if (shape.kind === 'rect') {
      cx = shape.x * w; cy = shape.y * h
      svg.appendChild(el('rect', { x: cx, y: cy, width: shape.w * w, height: shape.h * h, rx: 4, 'class': 'shape ' + cls }))
    } else {
      var d = shape.points.map(function (p, i) { return (i ? 'L' : 'M') + (p[0] * w).toFixed(1) + ' ' + (p[1] * h).toFixed(1) }).join(' ')
      svg.appendChild(el('path', { d: d, 'class': 'pen ' + cls }))
      cx = shape.points[0][0] * w; cy = shape.points[0][1] * h
    }
    if (label) {
      svg.appendChild(el('circle', { cx: cx, cy: cy - 22, r: 10, 'class': 'badge ' + cls }))
      var t = el('text', { x: cx, y: cy - 22, 'class': 'badge-text ' + cls })
      t.textContent = label
      svg.appendChild(t)
    }
  }

  function render() {
    var svg = $('overlay')
    var target = surface()
    if (!state.page || target.hidden) { svg.replaceChildren(); return }
    var w = target.offsetWidth, h = target.offsetHeight
    svg.style.left = target.offsetLeft + 'px'
    svg.style.top = target.offsetTop + 'px'
    svg.setAttribute('width', w)
    svg.setAttribute('height', h)
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h)
    svg.classList.toggle('passive', state.view === 'live' && !state.liveAnnotate)
    svg.replaceChildren()
    if (state.view === 'still') {
      listed().forEach(function (c, i) { if (c.shape && c.pageId === state.page.id) drawShape(svg, c.shape, w, h, c.mine ? '' : 'other', String(i + 1)) })
    }
    if (state.shape) drawShape(svg, state.shape, w, h, '', '')
    var note = !state.shape ? T.noShape : state.shape.kind === 'pin' ? T.withPin : state.shape.kind === 'rect' ? T.withRect : T.withPen
    text($('shape-note'), note)
    $('clear-shape').disabled = !state.shape
  }

  /* ── 一覧と送信 ─────────────────────────── */

  function listed() {
    var others = (state.share && state.share.comments || []).filter(function (c) { return !state.mine.some(function (m) { return m.id === c.id }) })
    return others.concat(state.mine).filter(function (c) { return state.page && c.pageId === state.page.id })
  }

  function renderList() {
    var list = $('list')
    list.replaceChildren()
    listed().forEach(function (c) {
      var li = document.createElement('li')
      var who = document.createElement('span')
      who.className = 'who'
      text(who, (c.mine ? T.yours + ' · ' : '') + (c.name || T.anonymous))
      var body = document.createElement('span')
      body.className = 'text'
      text(body, c.text)
      li.replaceChildren(who, body)
      list.appendChild(li)
    })
    $('list-title').hidden = list.children.length === 0
  }

  function send() {
    var value = $('text').value.trim()
    if (!value || !state.page) return
    var name = $('name').value.trim()
    storageSet(NAME_KEY, name)
    var payload = { pageId: state.page.id, text: value, website: $('website').value, viewWidth: Math.round(surface().offsetWidth) || undefined }
    if (name) payload.name = name
    if (state.shape) payload.shape = state.shape
    if (state.view === 'live') payload.live = { url: $('live-url').value.trim() || state.page.url }
    $('send').disabled = true
    status(T.sending, false)
    fetch('/v1/public/' + shareId + '/comments', {
      method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (body) { return { res: res, body: body } })
    }).then(function (r) {
      if (r.res.ok && r.body.ok) {
        state.mine.push({ id: r.body.id, pageId: state.page.id, name: name, text: value, shape: state.view === 'still' ? state.shape : null, mine: true })
        state.shape = null
        $('text').value = ''
        status(T.sent, false)
        renderList()
        render()
        return
      }
      var code = r.body && r.body.code
      status(code === 'rate_limited' ? T.rateLimited : code === 'too_long' ? T.tooLong : code === 'full' ? T.full : code === 'gone' ? T.gone : T.failed, true)
    }).catch(function () { status(T.failed, true) }).then(function () { $('send').disabled = false })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
`
