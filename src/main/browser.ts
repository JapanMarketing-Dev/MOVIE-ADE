import { WebContentsView, dialog, session, shell, type BaseWindow, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import { MOBILE_PRESET, type BrowserState, type ViewBounds, type Viewport } from '@shared/types'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'
import { normalizeUrl } from '@shared/projectUrl'
import {
  createExternalOpener,
  displayOrigin,
  installPermissionPolicy,
  isAllowedExternalUrl,
  isPageNavigationAllowed,
  isTabCaptureRequest,
  isTypedNavigationAllowed,
  windowOpenAction,
  type PermissionSessionLike
} from './webPolicy'

/**
 * 内蔵ブラウザ（設計 2章の WebContentsView = Chromium）。
 *
 * インスタンスは1つだけ作り、モード切替では bounds だけを動かす。
 * ビューを作り直さないので、エディタモード ⇄ フィードバックモードでページが再読込されない。
 */

/** WS-2 ログイン状態（Cookie）を保持する永続パーティション */
export const PARTITION = 'persist:ade-browser'

/**
 * 内蔵ブラウザで許す権限。レビューするページは信用しないので、既定ですべて断る。
 * 録画は別の録画ウインドウ（既定のセッション）がタブを録るので、ページにマイク・カメラ・画面共有は要らない。
 * 許すのは、ページの「コピー」ボタンが動くための書き込み専用・整形済みのクリップボードと、
 * 録画ウインドウからのタブ録画の問い合わせ（isTabCaptureRequest）だけ
 */
const BROWSER_ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

let browserSessionReady = false

/**
 * 内蔵ブラウザの session。権限の決まり（既定で拒否）と外部アプリの確認を、読み込みの前に必ず入れてから返す。
 * 内蔵ブラウザの session は必ずここから取ること
 */
export function browserSession(confirmWindow?: () => BaseWindow | null): Session {
  const ses = session.fromPartition(PARTITION)
  if (!browserSessionReady) {
    browserSessionReady = true
    installPermissionPolicy(ses as unknown as PermissionSessionLike,
      (query) => BROWSER_ALLOWED_PERMISSIONS.has(query.permission) || isTabCaptureRequest(query),
      (url, origin) => void openExternalFromPage(url, origin))
  }
  if (confirmWindow) confirmWindowOf = confirmWindow
  return ses
}

let confirmWindowOf: () => BaseWindow | null = () => null

/** 表示中のページが別のアプリ（mailto など）を開こうとした。許可リストのものだけ、確認してから渡す */
const openExternalFromPage = createExternalOpener({
  confirm: async ({ url, origin }) => {
    const options = {
      type: 'question' as const,
      buttons: [t('browser.external.open'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('browser.external.message'),
      detail: t('browser.external.detail', { origin: displayOrigin(origin) || '-', url: url.slice(0, 300) })
    }
    const parent = confirmWindowOf()
    const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return response === 0
  },
  open: (url) => shell.openExternal(url),
  onError: (err) => reportHandled(err, { area: 'browser', op: 'open external link' })
})

export class EmbeddedBrowser {
  private view: WebContentsView | null = null
  private window: BaseWindow | null = null
  private viewport: Viewport = 'desktop'
  /**
   * 端末エミュレーションを実際に有効化したか。
   * 一度も有効化していないのに解除を呼ばないための印。
   */
  private emulating = false
  /**
   * レンダラ（フレームウィジェット）ができているか。
   *
   * Electron 44 の `enableDeviceEmulation` / `disableDeviceEmulation` は、
   * まだレンダラが無い webContents に対して呼ぶとネイティブ側でヌル参照し、
   * メインプロセスごと落ちる（EXC_BAD_ACCESS）。`dom-ready` まで呼ばない。
   */
  private rendererReady = false
  private bounds: ViewBounds | null = null
  private listeners = new Set<(state: BrowserState) => void>()
  private lastState: BrowserState | null = null
  /** 最後の遷移が失敗したときの理由。次の読み込みが始まったら消す */
  private loadError: string | null = null

  /**
   * 表示幅が変わったことを録画へ知らせる（WS-3 → 操作ログの viewport イベント）。
   * 録画していないときは何もしない。
   */
  onViewportChange?: (width: number) => void

  /** 録画エンジンが録る対象。破棄済みなら null */
  get contents(): WebContents | null {
    return this.webContents
  }

  /** ページが描く前に見える地の色。配色の切り替えに合わせる */
  setBackgroundColor(color: string): void {
    this.view?.setBackgroundColor(color)
  }

  attach(window: BaseWindow, initialUrl: string, viewport: Viewport): void {
    this.window = window
    this.viewport = viewport

    const view = new WebContentsView({
      webPreferences: {
        // 権限の決まり（既定で拒否）を入れた session。ビューを作る＝読み込む前に入れる
        session: browserSession(() => this.window),
        // ペン・操作ログの注入スクリプト（設計4章）。
        // preload なのでページ本体のスクリプトとは別の世界で動き、遷移のたびに読み直される。
        preload: join(__dirname, '../preload/review.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // レビュー対象は開発中のローカルサイトであり、拡張機能的な注入は後続の
        // ペン・テキストレイヤーで行う。ここでは素のブラウザとして扱う。
        webSecurity: true
      }
    })
    this.view = view
    view.setBackgroundColor('#ffffff')
    window.contentView.addChildView(view)
    // bounds が renderer から届くまでは描画させない（0サイズ）
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

    const wc = view.webContents

    // 新規ウィンドウは開かず、同じビューで遷移させる。別のアプリへは mailto だけを、確認してから渡す。
    // file: data: javascript: や独自スキームは何もしない（ページから OS の URL ハンドラを呼ばせない）
    wc.setWindowOpenHandler(({ url }) => {
      const action = windowOpenAction(url)
      if (action === 'in-app') void wc.loadURL(url).catch(() => undefined)
      else if (action === 'external') void openExternalFromPage(url, wc.getURL())
      return { action: 'deny' }
    })
    // ページが始めた遷移（リンク・location の書き換え）。行けない先は止め、mailto は確認へ回す
    wc.on('will-navigate', (event) => {
      if (isPageNavigationAllowed(event.url, wc.getURL())) return
      event.preventDefault()
      if (isAllowedExternalUrl(event.url)) void openExternalFromPage(event.url, wc.getURL())
    })
    // サーバーの転送（リダイレクト）にも同じ決まりを当てる。独自スキームへの転送は、外部アプリの起動の権限（確認付き）へ回る
    wc.on('will-redirect', (event) => {
      if (isPageNavigationAllowed(event.url, wc.getURL())) return
      event.preventDefault()
      if (isAllowedExternalUrl(event.url)) void openExternalFromPage(event.url, wc.getURL())
    })

    const emit = (): void => this.emitState()
    wc.on('did-start-loading', () => {
      this.loadError = null
      emit()
    })
    wc.on('did-stop-loading', emit)
    wc.on('did-navigate', emit)
    wc.on('did-navigate-in-page', emit)
    wc.on('page-title-updated', emit)
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 は ERR_ABORTED（遷移のキャンセル）。通常運用で出るので黙って無視する
      if (code !== -3) console.warn(`[browser] 読み込み失敗 ${code} ${desc} ${url}`)
      // 白い画面のままにしない。理由を出して、URLの直しか再読み込みを促す
      if (code !== -3 && isMainFrame) this.loadError = loadErrorMessage(code)
      emit()
    })

    wc.on('dom-ready', () => {
      this.rendererReady = true
      // プロセスが入れ替わる遷移ではエミュレーションが外れるため、掛け直す
      if (this.viewport === 'mobile') this.emulating = false
      this.applyEmulation()
    })
    wc.on('render-process-gone', (_e, details) => {
      // レンダラが居なくなったら、できるまで emulation 系のAPIを呼ばない
      this.rendererReady = false
      this.emulating = false
      // 利用者のページのレンダラの終了。アプリの不具合ではないので送らない（アプリ自身の画面は telemetry.ts が拾う）
      console.warn(`[browser] レンダラが終了しました: ${details.reason}`)
    })

    // 前回の URL が開けない（形式が違う・許さないスキーム）なら空のまま。URL 欄から直せる
    void this.navigate(initialUrl).catch(() => undefined)
  }

  /** 破棄済みの webContents を触らない。すべての操作はこれを通す */
  private get webContents() {
    const wc = this.view?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  onStateChange(listener: (state: BrowserState) => void): void {
    this.listeners.add(listener)
  }

  state(): BrowserState {
    const wc = this.webContents
    if (!wc) {
      return {
        url: '',
        title: '',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        viewport: this.viewport
      }
    }
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      viewport: this.viewport,
      ...(this.loadError ? { loadError: this.loadError } : {})
    }
  }

  private emitState(): void {
    const next = this.state()
    const prev = this.lastState
    if (
      prev &&
      prev.url === next.url &&
      prev.title === next.title &&
      prev.canGoBack === next.canGoBack &&
      prev.canGoForward === next.canGoForward &&
      prev.loading === next.loading &&
      prev.viewport === next.viewport &&
      prev.loadError === next.loadError
    ) {
      return
    }
    this.lastState = next
    for (const listener of this.listeners) listener(next)
  }

  /** renderer が実測した領域。スマホ幅のときは中央に寄せて端末幅に収める */
  setBounds(bounds: ViewBounds | null): void {
    this.bounds = bounds
    this.applyBounds()
  }

  private applyBounds(): void {
    const view = this.view
    // 破棄済みのビューに bounds を入れない（終了処理と重なるとネイティブ側で落ちる）
    if (!view || !this.webContents) return
    if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    const { x, y, width, height } = this.bounds
    if (this.viewport === 'mobile') {
      const w = Math.min(MOBILE_PRESET.width, width)
      view.setBounds({
        x: Math.round(x + (width - w) / 2),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(height)
      })
    } else {
      view.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })
    }
  }

  setViewport(viewport: Viewport): void {
    if (this.viewport === viewport) return
    this.viewport = viewport
    this.applyEmulation()
    this.applyBounds()
    this.emitState()
    this.onViewportChange?.(
      viewport === 'mobile' ? MOBILE_PRESET.width : Math.round(this.bounds?.width ?? 0)
    )
  }

  /**
   * WS-3 代表的な端末サイズへのエミュレーション。
   * 幅そのものは bounds で変えるため、ここでは screen 系の値と UA を合わせる。
   * 再読込しないので、表示中のページの状態は保たれる。
   *
   * レンダラができる前（`dom-ready` 前）は何もしない。呼ぶとプロセスが落ちるため、
   * `dom-ready` のたびに掛け直す。
   */
  private applyEmulation(): void {
    const wc = this.webContents
    if (!wc || !this.rendererReady) return
    try {
      if (this.viewport === 'mobile') {
        wc.setUserAgent(MOBILE_PRESET.userAgent)
        wc.enableDeviceEmulation({
          screenPosition: 'mobile',
          screenSize: { width: MOBILE_PRESET.width, height: MOBILE_PRESET.height },
          viewPosition: { x: 0, y: 0 },
          viewSize: { width: MOBILE_PRESET.width, height: MOBILE_PRESET.height },
          deviceScaleFactor: 0,
          scale: 1
        })
        this.emulating = true
      } else {
        if (this.emulating) {
          this.emulating = false
          wc.disableDeviceEmulation()
        }
        wc.setUserAgent(wc.session.getUserAgent())
      }
    } catch (err) {
      console.warn('[browser] 表示幅の切り替えに失敗しました', err)
      reportHandled(err, { area: 'browser', op: 'switch viewport' })
    }
  }

  async navigate(input: string): Promise<void> {
    const wc = this.webContents
    if (!wc) return
    const url = normalizeUrl(input)
    // javascript: data: や独自スキーム（OS のアプリを起動する）は開かない
    if (!isNavigableUrl(url) || !isTypedNavigationAllowed(url)) throw new UserFacingError(t('browser.errors.invalidUrl'))
    try {
      await wc.loadURL(url)
    } catch (err) {
      // 利用者のページへの遷移の失敗（相手のサーバー・回線）。画面に理由を出すので送らない
      const code = (err as { errno?: number }).errno
      if (code !== -3) console.warn(`[browser] 遷移できませんでした: ${url}`, err)
    }
    this.emitState()
  }

  back(): void {
    this.webContents?.navigationHistory.goBack()
  }

  forward(): void {
    this.webContents?.navigationHistory.goForward()
  }

  reload(): void {
    this.webContents?.reload()
  }

  /**
   * ビューを明示的に捨てる。
   *
   * アプリ終了時には呼ばないこと。ウィンドウを閉じる処理と、こちらの
   * `removeChildView` + `webContents.close()` が重なると二重破棄になりうる。
   * 終了時のビューの後始末は Electron に任せる。
   */
  dispose(): void {
    const view = this.view
    this.view = null
    this.rendererReady = false
    this.emulating = false
    if (!view) return
    try {
      if (this.window && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(view)
      }
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch (err) {
      console.warn('[browser] ビューの破棄中にエラーが出ました', err)
      reportHandled(err, { area: 'browser', op: 'destroy view' })
    }
    this.window = null
  }
}

/** スキームを補ったあとも URL として読めるか（ホスト名に空白を含む入力などを弾く） */
export function isNavigableUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    // 入力の検証。読めない URL は想定内
    return false
  }
}

/** Chromium のエラー番号を、利用者向けの短い文にする */
export function loadErrorMessage(code: number): string {
  // -102 接続拒否 / -105 名前解決失敗 / -106 オフライン / -118 タイムアウト / -109 到達不可 / -312 禁止ポート
  if (code === -102 || code === -109 || code === -118) {
    return t('browser.errors.connectionRefused')
  }
  if (code === -312) return t('browser.errors.unsafePort')
  if (code === -105) return t('browser.errors.nameNotResolved')
  if (code === -106) return t('browser.errors.offline')
  return t('browser.errors.generic')
}
