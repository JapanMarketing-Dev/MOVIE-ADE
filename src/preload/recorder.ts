import { contextBridge, ipcRenderer } from 'electron'

/**
 * 録画用ウィンドウの preload。
 * アプリ本体のIPC（@shared/ipc）とは別系統で、録画の制御だけを通す。
 */
const CH = {
  start: 'ade-recorder:start',
  pause: 'ade-recorder:pause',
  resume: 'ade-recorder:resume',
  stop: 'ade-recorder:stop',
  video: 'ade-recorder:video',
  pcm: 'ade-recorder:pcm',
  level: 'ade-recorder:level',
  error: 'ade-recorder:error',
  stopped: 'ade-recorder:stopped'
  ,started: 'ade-recorder:started',
  grab: 'ade-recorder:grab',
  frame: 'ade-recorder:frame',
  overlay: 'ade-recorder:overlay'
} as const

contextBridge.exposeInMainWorld('adeRecorder', {
  onStart: (fn: (payload: unknown) => void) => ipcRenderer.on(CH.start, (_e, p) => fn(p)),
  onPause: (fn: () => void) => ipcRenderer.on(CH.pause, () => fn()),
  onResume: (fn: () => void) => ipcRenderer.on(CH.resume, () => fn()),
  onStop: (fn: () => void) => ipcRenderer.on(CH.stop, () => fn()),
  video: (chunk: ArrayBuffer) => ipcRenderer.send(CH.video, chunk),
  pcm: (block: unknown) => ipcRenderer.send(CH.pcm, block),
  level: (level: unknown) => ipcRenderer.send(CH.level, level),
  error: (message: string) => ipcRenderer.send(CH.error, message),
  stopped: () => ipcRenderer.send(CH.stopped),
  started: () => ipcRenderer.send(CH.started),
  // 画面全体・別のウインドウの静止画。main が番号付きで頼み、PNG を返す
  onGrab: (fn: (id: number) => void) => ipcRenderer.on(CH.grab, (_e, id: number) => fn(id)),
  frame: (id: number, png: ArrayBuffer | null) => ipcRenderer.send(CH.frame, id, png),
  // 内蔵ブラウザの上に重ねるもの（拡張機能のポップアップ）の取り込みの ID と位置。null で外す
  onOverlay: (fn: (overlay: unknown) => void) => ipcRenderer.on(CH.overlay, (_e, overlay) => fn(overlay))
})
