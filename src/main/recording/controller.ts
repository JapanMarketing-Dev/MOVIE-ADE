import { delay } from '@shared/delay'
import { ipcMain, type WebContents } from 'electron'
import { mkdir } from 'node:fs/promises'
import { appendFileNoFollow } from '../sessions/containment'
import { redactUrl } from '../pipeline/redact'
import { dirname, join } from 'node:path'
import { captureTargetGap, captureTargetLabel, resolveCaptureTarget } from '@shared/captureTarget'
import { RecordingClock } from './clock'
import { isPageChange } from '@shared/page'
import { DEFAULT_ANNOTATION_COLOR, type AnnotationColor } from '@shared/annotation'
import { RecorderWindow, type VideoSource } from './recorderWindow'
import { listCaptureSources, screenAccess } from './sources'
import { StillCapturer, webContentsStillSource, type StillSource } from './stills'
import {
  defaultRecordingOptions,
  type AudioLevel,
  type PcmBlock,
  type RecordingHandlers,
  type RecordingOptions,
  type RecordingResult,
  type RecordingState,
  type RecordingStatus
} from './types'
import type { Event } from '../pipeline/types'
import type { CaptureTarget } from '@shared/types'
import { shouldCaptureStill, toJsonLine, toLogEvent, type RawReviewEvent } from './events'
import { ReviewEventBudget, type Admission, type ReviewInputKind } from './eventBudget'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'

/**
 * 録画の司令塔（要件 5.3・5.4 / 設計 4章）。
 *
 * 1つの時計（RecordingClock）を持ち、動画・静止画・音声・操作ログの時刻をそこに揃える。
 * 各データは録画中に逐次ディスクへ書くので、落ちてもその時点まで残る（NF-12）。
 *
 * ──────────────────────── 使い方 ────────────────────────
 *   const rec = new RecordingController({ assets, handlers })
 *   rec.attach(browser.contents)            // 内蔵ブラウザの webContents
 *   await rec.start({ paths, captureSystemAudio: true })
 *   rec.setAnnotationMode('pen')            // ペンON（PEN-2）
 *   rec.pause() / rec.resume()
 *   const result = await rec.stop()
 */

const REVIEW_CHANNELS = {
  event: 'ade-review:event',
  command: 'ade-review:command',
  ready: 'ade-review:ready',
  /** 注入側の書き込みの「元に戻す／やり直す」ができるか（ツールバーのボタンの有効・無効） */
  history: 'ade-review:history',
  /** ページに焦点があるときに押された、書き込みの道具の切り替えキー（ツールバーへ渡す） */
  shortcut: 'ade-review:shortcut'
} as const

/** 書き込みの道具。依頼は声とペンで行うので、ペンだけ（画面に文字を置く道具は廃止した） */
export type AnnotationMode = 'off' | 'pen' | 'rect'

/** 画面収録の許可が無いときの案内。選択画面の案内（CaptureTargetPicker）と同じ手順を書く */
function screenAccessMessage(): string {
  return t('recording.errors.screenPermission')
}

/**
 * ページが変わったとき、注入側が入力中の文を確定して返事をくれるまで待つ上限(ms)。
 * 返事が来なくても、書き込みを新しいページへ持ち越さないよう消して進める。
 */
const LEAVE_TIMEOUT_MS = 600

/** events.jsonl への書き込みの待ち行列の上限。ディスクが詰まっても、書けない操作ログをメモリに積み続けない */
const MAX_PENDING_EVENT_WRITES = 1000
/** 停止のとき、events.jsonl の書き込みを待つ上限(ms) */
const EVENT_WRITES_STOP_TIMEOUT_MS = 5_000

export interface RecordingAssets {
  recorderHtml: string
  recorderPreload: string
}

export class RecordingController {
  private source: WebContents | null = null
  private clock: RecordingClock | null = null
  private recorder: RecorderWindow | null = null
  private lastViewWidth = 0
  private lastCursor?: { x: number; y: number; view?: { width: number; height: number } }
  private stills: StillCapturer | null = null
  private options: RecordingOptions | null = null
  private state: RecordingState = 'idle'
  private startedAt = ''
  private readonly events: Event[] = []
  private readonly warnings: string[] = []
  private readonly samples: Record<'mic' | 'system', number> = { mic: 0, system: 0 }
  private annotationMode: AnnotationMode = 'off'
  /** 書き込みの色。録画をまたいで引き継ぐ（設定の capture.annotationColor） */
  private annotationColor: AnnotationColor = DEFAULT_ANNOTATION_COLOR
  private limitWarningTimer: NodeJS.Timeout | null = null
  private maxDurationTimer: NodeJS.Timeout | null = null
  private boundReview = false
  private statusTimer: NodeJS.Timeout | null = null
  private lastStatus: RecordingStatus | null = null
  private eventWrites: Promise<void> = Promise.resolve()
  private pendingEventWrites = 0
  /** 注入スクリプトから届く入力の頻度と総量の上限（録画ごとに作り直す） */
  private budget = new ReviewEventBudget()
  /** 上限で捨てたことを知らせたか（録画ごとに1度だけ出す） */
  private readonly limitWarned = new Set<Admission>()
  /** 書き込みが属するページのURL（ハッシュ違いは同じページ。page.ts） */
  private pageUrl = ''
  /** ページが変わり、書き込みを片付けている途中の行き先URL */
  private pendingLeave: string | null = null
  private leaveTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly assets: RecordingAssets,
    private readonly handlers: RecordingHandlers = {}
  ) {}

  /**
   * 録る対象（内蔵ブラウザの webContents）を結びつける。
   * モード切替でビューを作り直さないので1度でよい。
   */
  attach(contents: WebContents): void {
    this.source = contents
    this.bindReview()
    const wc = contents

    this.pageUrl = wc.getURL()

    // 遷移のたびに注入スクリプトが読み直されるので、現在のモードを送り直す
    wc.on('did-finish-load', () => this.pushMode())
    // 別のドキュメントへ移る前に、入力中の文を確定させる（ページを離れると吹き出しごと消えるため）
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && isPageChange(this.pageUrl, details.url)) {
        this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'commit' })
      }
    })
    // 別のドキュメントへ移ったときは注入スクリプトごと読み直されるので、書き込みは自然に消える
    wc.on('did-navigate', (_e, url) => {
      this.pageUrl = url
      this.recordNav(url)
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.onInPageNavigate(url)
    })
  }

  /**
   * SPA の画面遷移（pushState など）。ドキュメントはそのままなので、書き込みが残ってしまう。
   * パスかクエリが変わったら、その画面の書き込みを記録し終えてから消す（ハッシュだけなら残す）。
   *
   * 手順: 注入側へ leave → 入力中の文・描きかけの線を確定して送ってくる → 返事（left）
   *       → その静止画を撮り終えるのを待つ → 消す → 遷移を記録する。
   * 遷移の記録を最後にするので、確定した書き込みは前のページのURLの指摘になる（context.ts は直前の nav を見る）。
   */
  private onInPageNavigate(url: string): void {
    const changed = isPageChange(this.pageUrl, url)
    this.pageUrl = url
    if (!changed) {
      this.recordNav(url)
      return
    }
    if (this.state !== 'recording') {
      // 録画していない・一時停止中は書き込みが無効なので、残りがあっても消すだけ
      this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'clear', page: true })
      return
    }
    const first = this.pendingLeave === null
    this.pendingLeave = url
    if (!first) return
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'leave' })
    this.leaveTimer = setTimeout(() => void this.finishLeave(), LEAVE_TIMEOUT_MS)
    this.leaveTimer.unref?.()
  }

  /** 前のページの書き込みを記録し終えたので、消して新しいページの遷移を記録する */
  private async finishLeave(): Promise<void> {
    const url = this.pendingLeave
    if (url === null) return
    this.pendingLeave = null
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = null
    // 確定した書き込みの静止画（captureNow）は、消す前に撮り終える
    await this.stills?.settle()
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'clear', page: true })
    // 遷移直後の1枚に消し残りが写らないよう、注入側の描画が反映されるのを待つ
    await delay(60)
    this.recordNav(url)
  }

  private bindReview(): void {
    if (this.boundReview) return
    this.boundReview = true

    ipcMain.on(REVIEW_CHANNELS.ready, (event) => {
      if (event.sender === this.source) this.pushMode()
    })

    ipcMain.on(REVIEW_CHANNELS.history, (event, history: unknown) => {
      if (event.sender !== this.source || !this.admit('history')) return
      const value = history as { canUndo?: unknown; canRedo?: unknown } | null
      this.handlers.onAnnotationHistory?.({ canUndo: value?.canUndo === true, canRedo: value?.canRedo === true })
    })

    ipcMain.on(REVIEW_CHANNELS.shortcut, (event, action: unknown) => {
      if (event.sender !== this.source || this.state !== 'recording' || !this.admit('shortcut')) return
      if (action === 'pen' || action === 'rect' || action === 'off' || action === 'color') this.handlers.onAnnotationShortcut?.(action)
    })

    ipcMain.on(REVIEW_CHANNELS.event, (event, raw: RawReviewEvent) => {
      if (event.sender !== this.source) return
      // ページ移動に伴う確定が済んだ返事（onInPageNavigate）
      if (raw?.type === 'left') return void this.finishLeave()
      this.recordInjected(raw)
    })
  }

  private get reviewContents(): WebContents | null {
    const wc = this.source
    return wc && !wc.isDestroyed() ? wc : null
  }

  private pushMode(): void {
    const wc = this.reviewContents
    if (!wc) return
    wc.send(REVIEW_CHANNELS.command, {
      type: 'config',
      maxHoldMs: this.options?.annotationMaxHoldMs ?? 30_000,
      color: this.annotationColor
    })
    wc.send(REVIEW_CHANNELS.command, {
      type: this.state === 'recording' ? 'enable' : 'disable'
    })
    if (this.state === 'recording') {
      wc.send(REVIEW_CHANNELS.command, { type: 'mode', mode: this.annotationMode })
    }
  }

  /** ペン／四角の枠／OFF の切り替え（PEN-2） */
  setAnnotationMode(mode: AnnotationMode): void {
    this.annotationMode = mode
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'mode', mode })
  }

  /** 書き込みの色。描いてあるものはそのままで、次に描くものから変わる */
  setAnnotationColor(color: AnnotationColor): void {
    this.annotationColor = color
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'color', color })
  }

  /**
   * 書き込み（線・四角の枠）を消す（PEN-3）。
   *
   * 呼び出し元は2つ:
   * - 手動の［消去］ボタン
   * - **発話の区切り**。pipeline の `SilenceSegmenter` が区切りを出した時点で呼ぶ
   *   （`new SilenceSegmenter((chunk) => { …; recording.clearAnnotations() })`）
   *
   * スクロールでの消去は注入スクリプト側が自分で行う。ページ遷移での消去は onInPageNavigate
   * （SPA）と、ドキュメントの読み直し（通常の遷移）で行う。
   * 指示が来ないまま残り続けないよう、注入側に上限（既定30秒）の保険がある。
   */
  clearAnnotations(manual = false): void {
    // 手動の［消去］だけは「元に戻す」で画面に戻せる。発話の区切りでの消去は戻す手順も片付ける
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'clear', ...(manual ? { manual: true } : {}) })
  }

  /** 書き込みを一つ前に戻す・やり直す（描く・動かす・消去が1手） */
  undoAnnotation(): void {
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'undo' })
  }

  redoAnnotation(): void {
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'redo' })
  }

  get status(): RecordingStatus {
    return {
      state: this.state,
      elapsedMs: this.clock?.now() ?? this.lastStatus?.elapsedMs ?? 0,
      videoBytes: this.recorder?.videoBytes ?? this.lastStatus?.videoBytes ?? 0,
      frameCount: this.stills?.captured.length ?? this.lastStatus?.frameCount ?? 0,
      eventCount: this.events.length
    }
  }

  async start(partial: Partial<RecordingOptions> & Pick<RecordingOptions, 'paths'>): Promise<void> {
    if (this.state !== 'idle') throw new UserFacingError(t('recording.errors.alreadyRecording'))
    const source = this.reviewContents
    const options: RecordingOptions = { ...defaultRecordingOptions, ...partial }
    const video = await this.resolveVideo(options, source)
    this.events.length = 0
    this.budget = new ReviewEventBudget()
    this.limitWarned.clear()
    this.lastViewWidth = 0
    this.lastCursor = undefined
    this.warnings.length = 0
    this.samples.mic = this.samples.system = 0
    this.annotationMode = 'off'
    this.lastStatus = null
    this.pendingLeave = null

    this.options = options
    // 画面全体・別のウインドウでは、内蔵ブラウザ専用の情報が欠けることを指摘に明記する
    const gap = captureTargetGap(options.captureTarget)
    if (gap) this.warnings.push(gap)
    await mkdir(options.paths.framesDir, { recursive: true })
    await mkdir(options.paths.audioDir, { recursive: true })

    const clock = new RecordingClock()
    this.clock = clock
    this.startedAt = new Date(clock.startedAtEpoch).toISOString()
    this.state = 'recording'

    this.recorder = new RecorderWindow(this.assets.recorderHtml, this.assets.recorderPreload, {
      onPcm: (block) => this.onPcm(block),
      onLevel: (level) => this.onLevel(level),
      onError: (message) => this.warn(message)
    })
    try {
      await this.recorder.open()
      await this.recorder.start(video, options, clock.startedAtEpoch)
    } catch (err) {
      this.recorder.dispose()
      this.recorder = null
      this.clock = null
      this.state = 'idle'
      this.emitStatus()
      throw err
    }

    const recorder = this.recorder
    const stillSource: StillSource =
      video.kind === 'tab'
        ? webContentsStillSource(video.contents)
        : { capture: () => recorder.grabFrame(), get gone() { return recorder.gone } }
    this.stills = new StillCapturer(stillSource, clock, options, {
      // カーソルの座標は内蔵ブラウザの中のものなので、画面・ウインドウの画像には重ねない
      getCursor: () => (video.kind === 'tab' ? this.lastCursor : undefined),
      onFrame: (frame) => {
        this.eventWrites = this.eventWrites.then(() => appendFileNoFollow(join(dirname(options.paths.eventsPath), 'frames.jsonl'), JSON.stringify(frame) + '\n')).catch((err) => { reportHandled(err, { area: 'recording', op: 'save frame times' }); this.warn(t('recording.errors.frameTimesSaveFailed', { error: String(err) })) })
        this.handlers.onFrame?.(frame)
      },
      onWarning: (message) => this.warn(message)
    })
    this.stills.start()

    this.pushMode()
    if (source) {
      this.pageUrl = source.getURL()
      this.recordNav(this.pageUrl)
    }

    this.limitWarningTimer = setTimeout(() => this.warn(t('recording.limitSoon')), Math.max(0, options.maxDurationMs - Math.min(300000, options.maxDurationMs / 10)))
    this.limitWarningTimer.unref?.()
    // REC-6 上限時間
    this.maxDurationTimer = setTimeout(() => {
      this.warn(t('recording.limitReached', { limit: formatLimit(options.maxDurationMs) }))
      void (this.handlers.onLimit?.() ?? this.stop()).catch((err) => { reportHandled(err, { area: 'recording', op: 'stop at time limit' }); this.warn(t('recording.errors.stopFailed', { error: String(err) })) })
    }, options.maxDurationMs)
    this.maxDurationTimer.unref?.()
    this.statusTimer = setInterval(() => this.emitStatus(), 250)
    this.statusTimer.unref?.()

    this.emitStatus()
  }

  /**
   * 映像の取り込み元を決める。画面・ウインドウは、許可と対象の存在をここで確かめる
   * （録画を始めてから映像が空と分かるより、始める前に理由を伝えたほうが直しやすい）。
   */
  private async resolveVideo(options: RecordingOptions, source: WebContents | null): Promise<VideoSource> {
    if (options.captureTarget.kind === 'browser') {
      if (!source) throw new UserFacingError(t('recording.errors.noBrowser'))
      return { kind: 'tab', contents: source }
    }
    const resolved = await this.checkTarget(options.captureTarget)
    options.captureTarget = resolved
    return { kind: 'desktop', sourceId: resolved.kind === 'browser' ? '' : resolved.sourceId }
  }

  /**
   * 画面・ウインドウを録れるか確かめ、いまの ID に直した対象を返す。録れなければ理由を投げる。
   * セッションのフォルダを作る前にも呼ぶ（空のレビューを残さないため）。
   */
  async checkTarget(target: CaptureTarget): Promise<CaptureTarget> {
    if (target.kind === 'browser') return target
    const access = screenAccess()
    if (access === 'denied' || access === 'restricted') throw new Error(screenAccessMessage())
    const sources = await listCaptureSources({ width: 0, height: 0 }).catch((err: unknown) => { reportHandled(err, { area: 'recording', op: 'list capture sources' }); return [] })
    const resolved = resolveCaptureTarget(target, sources)
    if (!resolved) {
      throw new UserFacingError(t('recording.errors.targetGone', { target: captureTargetLabel(target) }))
    }
    return resolved
  }

  /** 内蔵ブラウザを録っているか。画面・ウインドウのときは内蔵ブラウザの操作ログを取らない */
  private get recordsBrowser(): boolean {
    return (this.options?.captureTarget.kind ?? 'browser') === 'browser'
  }

  pause(): void {
    if (this.state !== 'recording') return
    this.state = 'paused'
    this.clock?.pause()
    this.recorder?.pause()
    this.stills?.pause()
    this.pushMode()
    this.emitStatus()
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'recording'
    this.clock?.resume()
    this.recorder?.resume()
    this.stills?.resume()
    this.pushMode()
    this.emitStatus()
  }

  async stop(): Promise<RecordingResult> {
    if (this.state === 'idle') throw new UserFacingError(t('recording.errors.notRecording'))
    this.state = 'stopping'
    if (this.limitWarningTimer) clearTimeout(this.limitWarningTimer)
    this.limitWarningTimer = null
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
    this.maxDurationTimer = null
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = null
    this.pendingLeave = null
    this.emitStatus()

    // 長さは「止める直前」の時計を使う。停止処理にかかる時間を含めると、
    // 動画の長さと数百msずれる
    const clock = this.clock
    const durationMs = clock?.now() ?? 0

    console.log('[STEP] stills.stop')
    await this.stills?.stop()
    console.log('[STEP] recorder.stop 開始')
    await this.recorder?.stop()
    console.log('[STEP] recorder.stop 完了')

    const options = this.options
    const videoBytes = this.recorder?.videoBytes ?? 0
    const frames = this.stills?.captured ?? []
    // 書き込みの待ち行列は MAX_PENDING_EVENT_WRITES 件までだが、ディスクが詰まっても停止を待たせ続けない
    await Promise.race([this.eventWrites, new Promise((done) => setTimeout(done, EVENT_WRITES_STOP_TIMEOUT_MS).unref?.())])
    this.lastStatus = { state: 'idle', elapsedMs: durationMs, videoBytes,
      frameCount: frames.length, eventCount: this.events.length }

    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'disable' })
    this.recorder?.dispose()
    this.recorder = null
    this.stills = null
    this.clock = null
    this.state = 'idle'
    this.emitStatus()

    return {
      startedAt: this.startedAt,
      durationMs,
      videoPath: options?.paths.videoPath ?? '',
      videoBytes,
      frames,
      events: [...this.events],
      audioSamples: { ...this.samples },
      warnings: [...this.warnings]
    }
  }

  dispose(): void {
    if (this.limitWarningTimer) clearTimeout(this.limitWarningTimer)
    this.limitWarningTimer = null
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.recorder?.dispose()
    this.recorder = null
    this.stills?.stop()
  }

  // ───────────────────────── 受け口 ─────────────────────────

  private onPcm(block: PcmBlock): void {
    this.samples[block.source] += block.samples.length
    this.handlers.onPcm?.(block)
  }

  private onLevel(level: AudioLevel): void {
    this.handlers.onLevel?.(level)
  }

  private warn(message: string): void {
    console.warn('[recording]', message)
    this.warnings.push(message)
    this.handlers.onWarning?.(message)
  }

  private emitStatus(): void {
    this.handlers.onStatus?.(this.status)
  }

  /** 操作ログを1件足す。追記のみでファイルへも書く */
  private push(event: Event): void {
    const path = this.options?.paths.eventsPath
    if (path && this.pendingEventWrites >= MAX_PENDING_EVENT_WRITES) return void this.warnLimit('total')
    this.events.push(event)
    this.handlers.onEvent?.(event)
    if (!path) return
    this.pendingEventWrites++
    // 末端がリンク・ハードリンクなら書かない（events.jsonl はプロジェクトのフォルダの中にある）
    this.eventWrites = this.eventWrites.then(() => appendFileNoFollow(path, toJsonLine(event)))
      .catch((err) => { reportHandled(err, { area: 'recording', op: 'save events' }); this.warn(t('recording.errors.eventsSaveFailed', { error: String(err) })) })
      .finally(() => { this.pendingEventWrites-- })
  }

  /** 注入スクリプトから届いた入力を、頻度と総量の上限の内で受け付けるか。超えたら捨てて1度だけ知らせる */
  private admit(kind: ReviewInputKind): boolean {
    const admission = this.budget.admit(kind)
    if (admission === 'ok') return true
    // 記録しない入力（カーソル位置・キー・戻せるかの知らせ）は、黙って間引く
    if (kind !== 'pointer' && kind !== 'shortcut' && kind !== 'history') this.warnLimit(admission)
    return false
  }

  private warnLimit(admission: Admission): void {
    if (this.limitWarned.has(admission)) return
    this.limitWarned.add(admission)
    this.warn(t(admission === 'total' ? 'recording.errors.eventsLimitReached' : 'recording.errors.eventsThrottled'))
  }

  private recordNav(url: string): void {
    if (this.state !== 'recording' || !this.clock || !url || url === 'about:blank') return
    // 画面・ウインドウを録っているときの内蔵ブラウザのURLは、録っている画面のURLとは限らない
    if (!this.recordsBrowser) return
    // ページのスクリプトが pushState やハッシュの変更を繰り返しても、操作ログと撮影を積み続けない
    if (!this.admit('nav')) return
    const wc = this.reviewContents
    this.push({
      t: this.clock.now(),
      type: 'nav',
      url: redactUrl(url),
      title: wc?.getTitle() ?? ''
    })
    // 遷移直後の画面は指摘の文脈になるので1枚撮る
    void this.stills?.captureNow('nav')
  }

  /** 表示幅の切替（WS-3）。browser.ts の setViewport から呼ぶ */
  recordViewport(width: number, t?: number): void {
    if (this.state !== 'recording' || !this.clock || !this.recordsBrowser) return
    this.lastViewWidth = width
    this.push({ t: t ?? this.clock.now(), type: 'viewport', width })
  }

  private recordInjected(raw: RawReviewEvent): void {
    const clock = this.clock
    if (this.state !== 'recording' || !clock || typeof raw !== 'object' || raw === null) return

    if (raw.type === 'pointer' && !this.admit('pointer')) return
    const view = sanitizeView(raw.view)
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y) && view) this.lastCursor = { x: raw.x!, y: raw.y!, view }
    if (raw.type === 'pointer') return
    let event = toLogEvent(raw, (epochMs) => clock.fromEpoch(epochMs))
    if (!event || event.type === 'nav' || event.type === 'viewport') return
    if (!this.admit(event.type)) return
    if (!this.recordsBrowser) {
      // 画面・ウインドウを録っているときは、書き込み（指摘そのもの）だけ残す。
      // 要素情報は内蔵ブラウザの中のもので、録っている画面と食い違いうるので外す
      if (event.type === 'erase') return void this.push(event)
      if (event.type !== 'pen') return
      const { el: _el, ...rest } = event
      event = rest
      this.push(event)
      void this.stills?.captureNow(event.type, undefined, event.id)
      return
    }
    if (view && this.lastViewWidth !== view.width) this.recordViewport(view.width, event.t)
    this.push(event)

    if (!shouldCaptureStill(event)) return
    // ペンの確定時とクリック時は、間隔を待たずにその場で撮る（設計4章）
    const cursor = event.type === 'click' ? { x: event.x, y: event.y, view } : undefined
    void this.stills?.captureNow(event.type, cursor, event.type === 'pen' ? event.id : undefined)
  }

}

/** 注入スクリプトが添えるビューの大きさ。数でない・極端な値は使わない */
function sanitizeView(view: unknown): { width: number; height: number } | undefined {
  const value = view as { width?: unknown; height?: unknown } | null | undefined
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100_000
  return value && ok(value.width) && ok(value.height) ? { width: Math.round(value.width), height: Math.round(value.height) } : undefined
}

/** 上限時間の表示。1分未満（検証用の短縮時）でも「0分」と出さない */
function formatLimit(ms: number): string {
  return ms >= 60_000 ? t('recording.minutes', { n: Math.round(ms / 60_000) }) : t('recording.seconds', { n: Math.max(1, Math.round(ms / 1000)) })
}
