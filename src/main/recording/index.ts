/**
 * 録画エンジン（要件 5.3・5.4 / 設計 4章）。
 * 起動を軽くするため、main からは録画を始める時点で動的 import する。
 *
 * ──────────────────────────── 使い方 ────────────────────────────
 *
 * 【プロジェクトを開いたとき（1回）】
 *   const { RecordingController } = await import('./recording')
 *   recording = new RecordingController(
 *     { recorderHtml: join(__dirname, '../recorder/index.html'),
 *       recorderPreload: join(__dirname, '../preload/recorder.js') },
 *     { onPcm, onEvent, onFrame, onStatus, onLevel, onWarning }
 *   )
 *   recording.attach(browser.contents)     // 内蔵ブラウザの webContents。1度でよい
 *
 * 【録画開始】セッションの置き場所を渡すだけ
 *   const paths = await createSession(projectDir)        // src/main/sessions
 *   await recording.start({
 *     paths: { videoPath: join(paths.dir, 'recording.webm'),
 *              framesDir: paths.framesDir, audioDir: paths.audioDir,
 *              eventsPath: join(paths.dir, 'events.jsonl') },
 *     captureSystemAudio: twoSpeakers                     // AUD-1
 *   })
 *
 * 【録画中】
 *   recording.setAnnotationMode('pen')                    // PEN-2
 *   recording.clearAnnotations()                          // 発話の区切りで呼ぶ（下記）
 *   recording.recordViewport(390)                         // 表示幅の切替（WS-3）
 *   recording.pause() / recording.resume()                // REC-1
 *
 * 【停止】
 *   const result = await recording.stop()
 *   // result.events / result.frames をそのまま pipeline の Material に渡せる
 *
 * ──────────────────────── 音声と分解のつなぎ ────────────────────────
 *
 * `onPcm` に 16kHz モノラルの Int16 が届くので、系統ごとに SilenceSegmenter へ流す。
 * 区切りが出た時点が「発話の区切り」なので、そこで `clearAnnotations()` を呼ぶと、
 * 線とテキストが指摘の単位で消える（設計4章）。
 *
 *   const segmenter = new SilenceSegmenter((chunk) => {
 *     wavChunkWriter(...)(chunk)
 *     recording.clearAnnotations()
 *   }, { maxChunkMs: recommendedMaxChunkMs(kind) })
 *   onPcm: (block) => { if (block.source === 'mic') segmenter.push(block.samples) }
 *
 * ──────────────────────── 気をつけること ────────────────────────
 *
 * - 録画はUIとは別の**非表示ウィンドウ**で動く。モード切替でUIを作り直しても切れない。
 * - E2Eで `--use-fake-ui-for-media-stream` / `--use-fake-device-for-media-stream` を
 *   付けてはいけない。タブ録画が `NotFoundError` で失敗する。
 *   音声を伴う自動テストでは `syntheticMic: true` を使う（実機デバイスを開かない）。
 * - 動画の時刻は録画の時計と ±0.4秒ほどずれる。指摘の画像は静止画（時刻が正確）を使い、
 *   動画は見返し用に留める。`<video>` の `duration` は読み込み後に
 *   `currentTime = 1e101` へ一度シークさせると確定する。
 */

export { RecordingController } from './controller'
export type { AnnotationMode, RecordingAssets } from './controller'
export { RecordingClock } from './clock'
export { frameFileName, hasChanged, targetWidth } from './frames'
export { shouldCaptureStill, toJsonLine, toLogEvent } from './events'
export type { RawReviewEvent } from './events'
export { defaultRecordingOptions } from './types'
export type {
  AudioLevel,
  AudioSourceKind,
  PcmBlock,
  RecordingHandlers,
  RecordingOptions,
  RecordingPaths,
  RecordingResult,
  RecordingState,
  RecordingStatus
} from './types'
