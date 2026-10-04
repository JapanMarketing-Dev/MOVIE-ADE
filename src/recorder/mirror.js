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
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 30 } }
  }).then(function (stream) {
    video.srcObject = stream
    stream.getVideoTracks().forEach(function (track) { track.addEventListener('ended', function () { fail(null) }) })
  }).catch(fail)
})()
