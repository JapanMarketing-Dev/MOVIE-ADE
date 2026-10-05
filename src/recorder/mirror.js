// 録画の対象の画面・ウインドウ（desktopCapturer の ID は URL の source）を映すだけ。音は取らない
;(function () {
  var params = new URLSearchParams(location.search)
  var id = params.get('source') || ''
  var video = document.getElementById('mirror')
  var note = document.getElementById('note')
  function fail(err) {
    // 映せない（ウインドウが閉じた・画面収録の許可が無い）。理由の文は main が画面の言語で渡す
    note.textContent = params.get('message') || ''
    note.hidden = false
    video.hidden = true
    if (err) console.warn('mirror: ' + String(err && err.message || err))
  }
  if (!/^(screen|window):[\w:-]+$/.test(id)) return fail(null)
  // 検証用（E2E の偽の画面・ウインドウ。main の recording/fakeCapture.ts）。OS の画面収録に触れず、ID ごとに色の違う canvas を映す
  if (params.get('synthetic') === '1') {
    var canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    var ctx = canvas.getContext('2d')
    var hue = 0
    for (var i = 0; i < id.length; i++) hue = (hue * 31 + id.charCodeAt(i)) % 360
    var n = 0
    var draw = function () {
      ctx.fillStyle = 'hsl(' + hue + ', 70%, 45%)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect((n * 8) % canvas.width, 180, 40, 40)
      n++
    }
    draw()
    setInterval(draw, 100)
    video.srcObject = canvas.captureStream(10)
    return
  }
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 30 } }
  }).then(function (stream) {
    video.srcObject = stream
    stream.getVideoTracks().forEach(function (track) { track.addEventListener('ended', function () { fail(null) }) })
  }).catch(fail)
})()
