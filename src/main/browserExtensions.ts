import { Menu, WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron'
import { lstat, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import {
  OPTIONS_SIZE,
  chromiumUserDataDirs,
  clampPopupSize,
  isChromeExtensionId,
  isChromiumProfileDir,
  isOwnExtensionUrl,
  isPopupLinkAllowed,
  latestVersionDir,
  parseExtensionManifest,
  placePopup,
  resolveManifestMessage,
  type BrowserExtensionEntry,
  type BrowserExtensionInfo,
  type InstalledBrowserExtension,
  type ParsedManifest,
  type Rect
} from '@shared/browserExtensions'
import { reportHandled } from '@shared/report'
import { isGestureInput } from './captureConsent'
import { retireView } from './viewTeardown'
import { CRX_LIMITS, extractCrx, parseCrx } from './crx'

/**
 * 内蔵ブラウザのブラウザ拡張機能（Chrome 拡張）。
 *
 * 守っていること（拡張は利用者が入れたものでも、Ferret から見れば信用しないコード）:
 * - 読み込むのは内蔵ブラウザの session（persist:ade-browser）だけ。アプリの画面・録画ウインドウ（既定の session）には入れない。
 *   拡張の content script・background（service worker）・ポップアップが触れるのは、内蔵ブラウザのページとそのログイン（Cookie）まで
 * - allowFileAccess は付けない（手元のファイル・file: のページには触らせない）
 * - ポップアップ・設定ページのビューには、ふだん preload を入れない（Ferret の IPC を一切持たない）。sandbox・contextIsolation・Node なし。
 *   内蔵ブラウザの session の権限の決まり（既定で拒否。webPolicy.ts）もそのまま効く。
 *   例外は録画中・文字で指摘の間に開いたものだけで、内蔵ブラウザのページと同じ書き込みの注入スクリプト（preload/review）を入れる
 *   （ポップアップの上にもペン・枠・文字で指摘を引けるように。@shared/popupAnnotation の extensionPopupGetsReviewPreload）。
 *   注入スクリプトは別の世界で動き、拡張のスクリプトからは見えない。main は送り主（いま開いているポップアップ）を確かめて、書き込みのチャネルだけを受ける
 * - content script は拡張ごとの別の世界で動き、書き込みの注入スクリプト（preload/review）の世界には入れない
 * - 取り込み（Chrome から写す）は main が見つけた候補だけ。画面からパスは受け取らない。写すときはシンボリックリンクを辿らず、件数と総量に上限
 *
 * 残る危険（設定のページで利用者に伝える）: 拡張は内蔵ブラウザで開いたページを読み書きでき、host_permissions の範囲でそのログインのまま通信できる。
 * 信用できる拡張だけを入れること。
 */

/** manifest.json・messages.json を読む上限 */
const MAX_MANIFEST_BYTES = 1024 * 1024
/** 取り込みで写す上限（ファイル数・総量）。Chrome の拡張はふつう数 MB */
const IMPORT_LIMITS = { files: 5_000, bytes: 200 * 1024 * 1024 } as const

export interface ExtensionHost {
  /** ポップアップを置くウインドウ */
  window(): BaseWindow | null
  /** 内蔵ブラウザのビューの、いまの位置（ウインドウの中の DIP）。隠れている・映したウインドウを出しているときは null */
  viewBounds(): Rect | null
  /** ポップアップの中のリンク（http・https）を内蔵ブラウザで開く */
  navigate(url: string): void
  /** 開くポップアップに入れる書き込みの注入スクリプトのパス。入れないなら null（既定） */
  reviewPreload?(): string | null
  /** 書き込みの最中か。最中は Esc でポップアップを閉じない（注入スクリプトが道具を切る） */
  annotating?(): boolean
  /** ポップアップに本物の入力（クリック・キー）が届いた（文字で指摘の静止画の許可） */
  popupInput?(contents: WebContents): void
}

/** 録画・静止画に重ねるポップアップ（中身と、ウインドウの中の位置） */
export interface ExtensionPopupTarget {
  contents: WebContents
  bounds: Rect
}

/** ウェブストアから拡張のパッケージを取る URL（Chrome の更新の口。Google の配布の置き場へ転送される） */
export function webStoreCrxUrl(id: string, chromeVersion: string): string {
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(chromeVersion)}&acceptformat=crx3&x=${encodeURIComponent(`id=${id}&uc`)}`
}

/** ウェブストアにその拡張が無い（ID の誤り・公開をやめた・この地域では出ていない） */
export class WebStoreNotFoundError extends Error {}

/** 上限付きで読む（大きすぎるファイル・シンボリックリンクは読まない） */
async function readSmallFile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    // 無い・読めないは「無い」として扱う（想定内）
    return null
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    // manifest には BOM やコメントは無い前提（Chrome も JSON として読む）
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    // 壊れた manifest は「拡張ではない」（想定内）
    return null
  }
}

/** フォルダの manifest.json を読み、名前の __MSG_xx__ を既定の言語の文に直す。拡張でなければ null */
export async function readExtensionManifest(dir: string): Promise<ParsedManifest | null> {
  const manifest = parseExtensionManifest(parseJson(await readSmallFile(join(dir, 'manifest.json'))))
  if (!manifest) return null
  if (manifest.name.startsWith('__MSG_') && manifest.defaultLocale) {
    const messages = parseJson(await readSmallFile(join(dir, '_locales', manifest.defaultLocale, 'messages.json')))
    manifest.name = resolveManifestMessage(manifest.name, messages)
  }
  return manifest
}

/** Chrome・Edge・Brave などのプロフィールに入っている拡張を探す（取り込みの候補）。key は「ブラウザ|フォルダ」 */
export async function scanInstalledExtensions(roots: Array<{ browser: string; dir: string }>, importedIds: Set<string>): Promise<Array<InstalledBrowserExtension & { dir: string }>> {
  const found: Array<InstalledBrowserExtension & { dir: string }> = []
  for (const root of roots) {
    let profiles: string[] = []
    try {
      profiles = (await readdir(root.dir)).filter(isChromiumProfileDir)
    } catch {
      // そのブラウザが入っていない（想定内）
      continue
    }
    for (const profile of profiles) {
      const extDir = join(root.dir, profile, 'Extensions')
      let ids: string[] = []
      try {
        ids = (await readdir(extDir)).filter(isChromeExtensionId)
      } catch {
        // 拡張が1つも無いプロフィール（想定内）
        continue
      }
      for (const id of ids) {
        try {
          const version = latestVersionDir(await readdir(join(extDir, id)))
          if (!version) continue
          const dir = join(extDir, id, version)
          const manifest = await readExtensionManifest(dir)
          if (!manifest || manifest.kind !== 'extension') continue
          found.push({ key: `${root.browser}|${dir}`, browser: root.browser, profile, id, name: manifest.name, version: manifest.version, imported: importedIds.has(id), dir })
        } catch {
          // 読めない拡張は候補から外す（想定内）
        }
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** この OS で探す Chromium 系のブラウザ */
export function defaultChromiumRoots(home: string): Array<{ browser: string; dir: string }> {
  return chromiumUserDataDirs(process.platform, home, process.env)
}

/**
 * 拡張のフォルダを写す。Chrome が付ける _metadata（Electron の読み込みが「_ で始まる名前は使えない」と断る）は写さない。
 * シンボリックリンク・特殊なファイルは写さない。件数・総量の上限を超えたら途中で止めて投げる（写しかけは消す）
 */
export async function copyExtensionDir(from: string, to: string, limits: { files: number; bytes: number } = IMPORT_LIMITS): Promise<void> {
  let files = 0
  let bytes = 0
  const walk = async (src: string, dest: string, top: boolean): Promise<void> => {
    await mkdir(dest, { recursive: true })
    for (const entry of await readdir(src, { withFileTypes: true })) {
      if (top && entry.name === '_metadata') continue
      const s = join(src, entry.name)
      const d = join(dest, entry.name)
      if (entry.isDirectory()) {
        await walk(s, d, false)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      if (files > limits.files) throw new Error('extension has too many files')
      // 開いた fd の大きさで数える（途中で差し替えられても、読む量は上限まで）
      const input = await open(s, constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0))
      try {
        const info = await input.stat()
        if (!info.isFile()) continue
        bytes += info.size
        if (bytes > limits.bytes) throw new Error('extension is too large')
        const data = await input.readFile()
        const out = await open(d, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)
        try {
          await out.writeFile(data)
        } finally {
          await out.close()
        }
      } finally {
        await input.close()
      }
    }
  }
  try {
    await walk(from, to, true)
  } catch (err) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/** dir の直下より深いところか（区切りまで見る。/a/bc は /a/b の中ではない） */
function isInside(path: string, dir: string): boolean {
  return path.length > dir.length + 1 && path.startsWith(dir) && (path[dir.length] === '/' || path[dir.length] === '\\')
}

/** フォルダか（シンボリックリンクは辿る。利用者が選んだ開発中のフォルダはリンクのことがある） */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // 無いフォルダ（想定内）
    return false
  }
}

/**
 * ツールバーの拡張機能のボタンから開くポップアップ（action.default_popup）と設定ページ（options）。
 *
 * Chrome のように別の窓には出さず、内蔵ブラウザのビューの右上に重ねる WebContentsView にする。
 * ビューの中に置くので、録画（ビューのタブ録画）には、録画ウインドウがこのビューも同じ位置に重ねて録る（recorder.ts の合成）
 */
class ExtensionPopup {
  readonly view: WebContentsView
  private size: { width: number; height: number }
  private shown = false
  private closed = false

  constructor(
    ses: Session,
    readonly extensionId: string,
    url: string,
    private readonly kind: 'popup' | 'options',
    private readonly host: ExtensionHost,
    private readonly onChange: () => void,
    private readonly onClosed: (popup: ExtensionPopup) => void
  ) {
    this.size = kind === 'options' ? { ...OPTIONS_SIZE } : { width: 25, height: 25 }
    const preload = host.reviewPreload?.() ?? null
    this.view = new WebContentsView({
      webPreferences: {
        // 内蔵ブラウザと同じ session（拡張はここにだけ読み込んである）。preload はふだん入れない＝Ferret の IPC を持たない。
        // 録画中・文字で指摘の間だけ、内蔵ブラウザのページと同じ書き込みの注入スクリプトを入れる
        session: ses,
        ...(preload ? { preload } : {}),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        // ポップアップは中身の大きさに合わせる（Chrome と同じ）
        enablePreferredSizeMode: kind === 'popup'
      }
    })
    this.view.setBackgroundColor('#ffffff')
    this.view.setVisible(false)
    const wc = this.view.webContents
    // 新しい窓は開かない。http・https のリンクは内蔵ブラウザで開く（Chrome では新しいタブ）
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isPopupLinkAllowed(target)) host.navigate(target)
      return { action: 'deny' }
    })
    // ポップアップの中の遷移は、その拡張自身のページの中だけ。外へ出るリンクは内蔵ブラウザで開く
    const guard = (event: { url: string; preventDefault: () => void }) => {
      if (isOwnExtensionUrl(event.url, extensionId)) return
      event.preventDefault()
      if (isPopupLinkAllowed(event.url)) host.navigate(event.url)
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.on('preferred-size-changed', (_event, preferred) => {
      if (this.kind !== 'popup') return
      this.size = clampPopupSize(preferred)
      this.layout()
    })
    // Esc で閉じる（Chrome と同じ）。書き込みの最中は閉じない（注入スクリプトが Esc で道具を切る・打ちかけの枠を取り消す）
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !host.annotating?.()) {
        event.preventDefault()
        this.close()
      }
    })
    // 文字で指摘の静止画の許可は、そのポップアップへの本物の入力からだけ作る
    wc.on('input-event', (_event, input) => { if (isGestureInput(input.type)) host.popupInput?.(wc) })
    // window.close() ・拡張の再読み込みで中身が無くなった。
    // その webContents 自身の destroyed・render-process-gone の中でビューを外したり閉じたりすると Electron のネイティブ側で
    // 落ちることがあるので、イベントを抜けてから閉じる
    wc.on('destroyed', () => setImmediate(() => this.close()))
    wc.on('did-finish-load', () => {
      this.shown = true
      this.layout()
      if (!wc.isDestroyed()) wc.focus()
    })
    wc.on('render-process-gone', () => setImmediate(() => this.close()))
    const window = host.window()
    if (window && !window.isDestroyed()) window.contentView.addChildView(this.view)
    void wc.loadURL(url).catch((err: unknown) => {
      reportHandled(err, { area: 'browser', op: 'load extension popup' })
      this.close()
    })
  }

  get contents(): WebContents | null {
    const wc = this.view.webContents
    return !this.closed && !wc.isDestroyed() ? wc : null
  }

  /** ウインドウの中の位置。見えていなければ null */
  bounds(): Rect | null {
    if (this.closed || !this.shown) return null
    const view = this.host.viewBounds()
    return view ? placePopup(view, this.size) : null
  }

  /** ビューの位置・大きさが変わった。ビューが隠れたら閉じる */
  layout(): void {
    if (this.closed) return
    // 中身が先に壊れたビュー（destroyed のあと、次のティックの close の前）に位置を入れない。FERRET-1Q（Windows の main の access-violation）
    if (this.view.webContents.isDestroyed()) return this.close()
    const view = this.host.viewBounds()
    if (!view) return this.close()
    const rect = this.bounds()
    if (rect) {
      this.view.setBounds(rect)
      this.view.setVisible(true)
    }
    this.onChange()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    retireView(this.host.window(), this.view, 'close extension popup')
    this.onClosed(this)
  }
}

interface LoadedExtension {
  id: string
  manifest: ParsedManifest
  /** 読み込んだときの読み込み直しの合図（BrowserExtensionEntry.reload。無ければ 0） */
  reload: number
}

/**
 * 設定の browserExtensions を内蔵ブラウザの session に読み込み、ポップアップを開く。
 * 読み込み・外しは1つずつ順に行う（重なると Electron が同じ拡張を二重に読む）
 */
export class BrowserExtensions {
  private readonly loaded = new Map<string, LoadedExtension>()
  private readonly manifests = new Map<string, ParsedManifest | null>()
  private readonly errors = new Map<string, string>()
  private entries: BrowserExtensionEntry[] = []
  private queue: Promise<void> = Promise.resolve()
  private popup: ExtensionPopup | null = null

  /** 一覧（読み込みの結果）が変わった */
  onChange?: () => void
  /** 読み込み直しの合図（reload）で拡張を読み込み直した */
  onReloaded?: () => void
  /** 開いているポップアップの位置・中身が変わった（録画に重ねる位置を直す）。閉じたら null */
  onPopupChange?: (popup: ExtensionPopupTarget | null) => void

  constructor(
    private readonly deps: {
      session: () => Session
      host: ExtensionHost
      /** Chrome から取り込んだ拡張を写す場所（設定フォルダの中） */
      importDir: () => string
    }
  ) {}

  /** 設定に合わせて読み込む・外す。終わるまで待てる */
  sync(entries: BrowserExtensionEntry[] | undefined): Promise<void> {
    this.entries = entries ?? []
    const run = this.queue.then(() => this.apply(this.entries))
    this.queue = run.catch((err: unknown) => reportHandled(err, { area: 'browser', op: 'sync extensions' }))
    return this.queue
  }

  private async apply(entries: BrowserExtensionEntry[]): Promise<void> {
    const ses = this.deps.session()
    const wanted = new Set(entries.filter((e) => e.enabled !== false).map((e) => e.path))
    const reloadOf = new Map(entries.map((e) => [e.path, e.reload ?? 0]))
    let reloaded = false
    for (const [path, ext] of [...this.loaded]) {
      // 読み込み直しの合図（reload）が変わったものは、外してからもう一度読み込む（フォルダの最新の中身になる）
      const stale = wanted.has(path) && (reloadOf.get(path) ?? 0) !== ext.reload
      if (wanted.has(path) && !stale) continue
      if (stale) reloaded = true
      if (this.popup?.extensionId === ext.id) this.closePopup()
      try {
        ses.extensions.removeExtension(ext.id)
      } catch (err) {
        reportHandled(err, { area: 'browser', op: 'remove extension' })
      }
      this.loaded.delete(path)
    }
    for (const entry of entries) {
      if (this.loaded.has(entry.path)) continue
      // 無効のものも名前・版を出すため読む（読み込みはしない）
      const manifest = await readExtensionManifest(entry.path)
      this.manifests.set(entry.path, manifest)
      if (!wanted.has(entry.path)) { this.errors.delete(entry.path); continue }
      if (!manifest) { this.errors.set(entry.path, 'manifest.json was not found or is not a Chrome extension (manifest_version 2 or 3).'); continue }
      try {
        // 手元のファイル（file:）には触らせない
        const ext = await ses.extensions.loadExtension(entry.path, { allowFileAccess: false })
        this.loaded.set(entry.path, { id: ext.id, manifest, reload: entry.reload ?? 0 })
        this.errors.delete(entry.path)
      } catch (err) {
        // 拡張の誤り（利用者のもの）。画面に理由を出すので送らない
        this.errors.set(entry.path, (err instanceof Error ? err.message : String(err)).slice(0, 500))
      }
    }
    for (const path of [...this.manifests.keys()]) if (!entries.some((e) => e.path === path)) { this.manifests.delete(path); this.errors.delete(path) }
    this.onChange?.()
    // 読み込み直したら、開いているページも読み込み直す（コンテンツスクリプトの変更をすぐ見られるように）
    if (reloaded) this.onReloaded?.()
  }

  /** 画面に出す一覧（設定の順） */
  list(): BrowserExtensionInfo[] {
    const importDir = this.deps.importDir()
    return this.entries.map((entry) => {
      const loaded = this.loaded.get(entry.path)
      const manifest = loaded?.manifest ?? this.manifests.get(entry.path) ?? null
      const error = this.errors.get(entry.path)
      return {
        path: entry.path,
        enabled: entry.enabled !== false,
        id: loaded?.id ?? null,
        name: manifest?.name ?? entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path,
        version: manifest?.version ?? '',
        hasPopup: !!manifest?.popup,
        hasOptions: !!manifest?.options,
        imported: isInside(entry.path, importDir),
        ...(error ? { error } : {})
      }
    })
  }

  /** ポップアップを持つ拡張が読み込まれているか（録画で、ポップアップを重ねる合成を使うか） */
  hasPopupExtensions(): boolean {
    return [...this.loaded.values()].some((ext) => !!ext.manifest.popup || !!ext.manifest.options)
  }

  /** 開いているポップアップ（録画・静止画に重ねる）。見えていなければ null */
  popupTarget(): ExtensionPopupTarget | null {
    const popup = this.popup
    const contents = popup?.contents
    const bounds = popup?.bounds()
    return popup && contents && bounds ? { contents, bounds } : null
  }

  /** 読み込み済みの拡張のポップアップ（または設定ページ）を開く。同じものが開いていれば閉じる */
  openPopup(path: string, kind: 'popup' | 'options' = 'popup'): boolean {
    const ext = this.loaded.get(path)
    const page = kind === 'popup' ? ext?.manifest.popup : ext?.manifest.options
    if (!ext || !page || !this.deps.host.viewBounds()) return false
    const same = this.popup?.extensionId === ext.id
    this.closePopup()
    if (same && kind === 'popup') return false
    this.popup = new ExtensionPopup(this.deps.session(), ext.id, `chrome-extension://${ext.id}/${page}`, kind, this.deps.host,
      () => { if (this.popup) this.onPopupChange?.(this.popupTarget()) },
      (closed) => {
        if (this.popup !== closed) return
        this.popup = null
        this.onPopupChange?.(null)
      })
    return true
  }

  closePopup(): void {
    this.popup?.close()
  }

  /** 内蔵ブラウザのビューが動いた・隠れた */
  relayout(): void {
    this.popup?.layout()
  }

  /**
   * ツールバーの拡張機能のボタンのメニュー（ネイティブのメニュー。ビューの上にも出る）。
   * 選んだのが「拡張機能を管理」なら 'manage'
   */
  showMenu(window: BaseWindow, at: { x: number; y: number }, labels: { manage: string; options: string; none: string; install?: string }): Promise<'manage' | 'install' | null> {
    return new Promise((resolve) => {
      let choice: 'manage' | 'install' | null = null
      const items: Electron.MenuItemConstructorOptions[] = []
      // 内蔵ブラウザでウェブストアの拡張のページを開いているとき（ストアの「Chrome に追加」は Ferret では動かない）
      if (labels.install) items.push({ label: labels.install, click: () => { choice = 'install' } }, { type: 'separator' })
      for (const info of this.list()) {
        if (!info.enabled || !info.id || (!info.hasPopup && !info.hasOptions)) continue
        if (info.hasPopup) items.push({ label: info.name, click: () => this.openPopup(info.path, 'popup') })
        if (info.hasOptions) items.push({ label: `${info.name} — ${labels.options}`, click: () => this.openPopup(info.path, 'options') })
      }
      if (!items.length) items.push({ label: labels.none, enabled: false })
      items.push({ type: 'separator' }, { label: labels.manage, click: () => { choice = 'manage' } })
      Menu.buildFromTemplate(items).popup({ window: window as Electron.BrowserWindow, x: Math.round(at.x), y: Math.round(at.y), callback: () => resolve(choice) })
    })
  }

  /** 取り込みの候補（Chrome などのプロフィール）。いま取り込み済みの ID に印を付ける */
  async scanInstalled(home: string): Promise<Array<InstalledBrowserExtension & { dir: string }>> {
    const importedIds = new Set(this.entries.filter((e) => isInside(e.path, this.deps.importDir())).map((e) => e.path.split(/[\\/]/).pop() ?? ''))
    return scanInstalledExtensions(defaultChromiumRoots(home), importedIds)
  }

  /** 設定フォルダの <id> に写しを作る（同じ ID の前の写しは、読み込みを外してから置き換える）。写した先のパス */
  private async replaceImported(id: string, write: (dest: string) => Promise<void>): Promise<string> {
    if (!isChromeExtensionId(id)) throw new Error('invalid extension id')
    const dest = join(this.deps.importDir(), id)
    const loaded = this.loaded.get(dest)
    if (loaded) {
      if (this.popup?.extensionId === loaded.id) this.closePopup()
      try { this.deps.session().extensions.removeExtension(loaded.id) } catch (err) { reportHandled(err, { area: 'browser', op: 'remove extension' }) }
      this.loaded.delete(dest)
    }
    await rm(dest, { recursive: true, force: true })
    await write(dest)
    this.manifests.delete(dest)
    return dest
  }

  /** 候補を設定フォルダへ写す（同じ ID の前の写しは置き換える）。写した先のパス */
  async importInstalled(candidate: { id: string; dir: string }): Promise<string> {
    return this.replaceImported(candidate.id, (dest) => copyExtensionDir(candidate.dir, dest))
  }

  /**
   * .crx（CRX3）のバイト列を確かめて展開し、設定フォルダに置く（crx.ts。署名と ID を確かめる）。expectedId を渡せば、その拡張でなければ断る。
   * 写した先のパス
   */
  async installCrx(bytes: Uint8Array, expectedId?: string): Promise<string> {
    const crx = parseCrx(bytes, expectedId)
    return this.replaceImported(crx.id, (dest) => extractCrx(crx, dest))
  }

  /**
   * Chrome ウェブストアから拡張を取って入れる。取るのは Google の配布の置き場からだけで、届いたパッケージの署名が
   * 指定した ID の拡張のものでなければ入れない（途中や配布元で別の拡張に差し替えられない）。写した先のパス
   */
  async installFromWebStore(id: string, download: (url: string, maxBytes: number) => Promise<{ status: number; body: Uint8Array }>, chromeVersion: string): Promise<string> {
    if (!isChromeExtensionId(id)) throw new Error('invalid extension id')
    const url = webStoreCrxUrl(id, chromeVersion)
    // リダイレクトの行き先が Google の配布の置き場かは download（webStoreDownload.ts）が1回ずつ確かめる
    const res = await download(url, CRX_LIMITS.packageBytes)
    if (res.status === 204 || res.status === 404 || (res.status === 200 && res.body.length === 0)) throw new WebStoreNotFoundError()
    if (res.status < 200 || res.status >= 300) throw new Error(`the Chrome Web Store answered ${res.status}`)
    return this.installCrx(res.body, id)
  }

  /** 取り込んだ写しを消す（設定から外したあと）。利用者のフォルダ（展開済みの開発中のもの）は消さない */
  async deleteImportedCopy(path: string): Promise<void> {
    const dir = this.deps.importDir()
    const id = path.slice(dir.length).replace(/^[\\/]/, '')
    if (!isInside(path, dir) || !isChromeExtensionId(id)) return
    await rm(join(dir, id), { recursive: true, force: true })
  }

  /** 選ばれたフォルダが拡張か（manifest.json がある）。拡張なら名前 */
  async inspectFolder(path: string): Promise<ParsedManifest | null> {
    if (!(await isDirectory(path))) return null
    const manifest = await readExtensionManifest(path)
    return manifest && manifest.kind === 'extension' ? manifest : null
  }

  dispose(): void {
    this.closePopup()
  }
}
