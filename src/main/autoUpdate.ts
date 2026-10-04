import type { UpdateCheckResult } from '@shared/appVersion'
import {
  AUTO_UPDATE_FIRST_CHECK_MS,
  AUTO_UPDATE_INTERVAL_MS,
  INSTALL_KIND,
  type AutoUpdateProgress,
  type AutoUpdateStatus,
  type InstallMethod
} from '@shared/appUpdate'
import type { VerifiedDownload } from './updateCheck'

/**
 * 裏での更新（自動更新）。新しい版を見つけたら裏でダウンロードし、署名した SHA256SUMS で確かめたファイルだけを、
 * OS ごとの方法（src/shared/appUpdate.ts の InstallMethod）で入れ替える。
 *
 * Orca由来: ~/bench/orca/src/main/updater/（MIT）の流れ
 *   - 確認は起動時（少し待ってから）・一定間隔・利用者の［更新を確認］（updater-setup.ts / updater-scheduling.ts）
 *   - ダウンロードの進み具合を percent で出し、終わったら「再起動して更新」（update-status-types.ts）
 *   - 二重のダウンロード・二重の入れ替えを止める（updater-download-install.ts の downloadInFlight）
 *   - macOS は Squirrel.Mac が更新を受け取り終えてから「準備ができた」とする（updater-mac-install.ts）
 * 違うところ: Orca は electron-updater が配信元の latest*.yml（中の sha512）を読み直して確かめる。このアプリは
 * 更新の確認（updateCheck.ts）で署名を確かめたファイルの名前・sha256・大きさだけを使い、ダウンロードした中身が
 * それと合ったときだけ入れ替えに進む（配信元の yml や、R2 だけを書き換えた中身は信じない）。
 *
 * ここは electron を読まない（単体テストで流れを確かめる）。入れ替えそのものは autoUpdateInstall.ts、
 * つなぎ込み（設定・IPC・再起動の確認）は index.ts。
 */

export interface AutoUpdateDeps {
  /** この OS・形の入れ替えの方法。null なら裏のダウンロードをしない（案内と手動のダウンロードだけ） */
  method: InstallMethod | null
  /** 裏の確認・ダウンロードを動かす（配布版、または E2E の偽の配信元）。開発版の起動では動かさない */
  enabled: boolean
  /** 本物の入れ替えをする（配布版で E2E でない）。false なら確かめるところまでで止め、再起動しない */
  canInstall: boolean
  /** 更新の確認（updateCheck.ts の checkForUpdate） */
  check(): Promise<UpdateCheckResult>
  /** 最後の確認で署名を確かめた、この OS・CPU 向けの決まった種類のファイル */
  verifiedFile(kind: VerifiedDownload['kind']): VerifiedDownload | null
  /** 確かめた大きさと sha256 で落とし、合ったものだけを dir/<名前> に置く（updateDownload.ts の downloadVerifiedTo） */
  download(file: VerifiedDownload, dir: string, onProgress: (received: number, total: number) => void, signal: AbortSignal): Promise<string>
  /** 前の起動で落としたものが残っていれば、その sha256（無ければ null） */
  hashFile(path: string): Promise<string | null>
  /** 落とした更新を置くフォルダ（userData/updates）。中の keep 以外を片付け、フォルダと keep の置き場所を返す */
  prepareDir(keep: string): Promise<{ dir: string; target: string }>
  /** macOS: 確かめた zip を Squirrel.Mac に渡し、受け取り終えるのを待つ。ほかの OS は何もしない */
  stage(method: InstallMethod, path: string, file: VerifiedDownload): Promise<void>
  /** 入れ替える（再起動する）。deb はインストーラーを開く */
  install(method: InstallMethod, path: string, file: VerifiedDownload): Promise<void>
  getAutoDownload(): boolean
  setAutoDownload(on: boolean): void
  emit(status: AutoUpdateStatus): void
  /** 失敗を Sentry へ（area: update） */
  report(err: unknown, op: string): void
  /** 画面に出す失敗の文（i18n） */
  failedMessage(): string
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
}

export class AutoUpdater {
  private check: UpdateCheckResult | null = null
  private checking: Promise<UpdateCheckResult> | null = null
  private progress: AutoUpdateProgress = { phase: 'idle' }
  /** 落とし終えて確かめたファイル（入れ替えに使う） */
  private downloaded: { path: string; file: VerifiedDownload } | null = null
  private downloadAbort: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private installing = false

  constructor(private readonly deps: AutoUpdateDeps) {}

  status(): AutoUpdateStatus {
    return {
      check: this.check,
      checking: this.checking !== null,
      progress: this.progress,
      autoDownload: this.deps.getAutoDownload(),
      supported: this.supported()
    }
  }

  /** 裏のダウンロードと入れ替えができるか。新しい版があるときは、その版にこの OS 向けの入れ替えのファイルがあるか */
  private supported(): boolean {
    const { method, enabled } = this.deps
    if (!enabled || !method) return false
    if (this.check?.state !== 'available') return true
    return this.target() !== null
  }

  private target(): VerifiedDownload | null {
    const method = this.deps.method
    if (!method || this.check?.state !== 'available') return null
    const file = this.deps.verifiedFile(INSTALL_KIND[method])
    // 確かめた版と、案内している版が違うものは使わない
    return file && file.version === this.check.latest ? file : null
  }

  private emit(): void {
    this.deps.emit(this.status())
  }

  private set(progress: AutoUpdateProgress): void {
    this.progress = progress
    this.emit()
  }

  /** 起動時（少し待って）と一定間隔で確かめる。enabled でなければ何もしない */
  start(): void {
    if (!this.deps.enabled) return
    this.schedule(AUTO_UPDATE_FIRST_CHECK_MS)
  }

  stop(): void {
    const timers = this.deps.timers ?? globalThis
    if (this.timer) timers.clearTimeout(this.timer)
    this.timer = null
    this.downloadAbort?.abort()
  }

  private schedule(delay: number): void {
    const timers = this.deps.timers ?? globalThis
    if (this.timer) timers.clearTimeout(this.timer)
    this.timer = timers.setTimeout(() => {
      this.timer = null
      void this.checkNow().finally(() => this.schedule(AUTO_UPDATE_INTERVAL_MS))
    }, delay)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /**
   * 確かめる（起動時・一定間隔・［更新を確認］）。新しい版があり、自動のダウンロードがオンなら、裏でダウンロードを始める。
   * 同時に2回は確かめない（走っている確認の結果を返す）
   */
  checkNow(): Promise<UpdateCheckResult> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      try {
        const result = await this.deps.check()
        // 落とし終えた版より新しい版が出たら、古い方は入れ替えに使わない
        if (result.state === 'available' && this.downloaded && this.downloaded.file.version !== result.latest && this.progress.phase !== 'downloading') {
          this.downloaded = null
          this.progress = { phase: 'idle' }
        }
        this.check = result
        return result
      } finally {
        this.checking = null
        this.emit()
      }
    })()
    this.emit()
    void this.checking.then(() => {
      if (this.deps.getAutoDownload()) void this.download()
    }).catch(() => undefined)
    return this.checking
  }

  /** 自動のダウンロードを切り替える（設定の autoUpdate）。オンにしたとき新しい版があれば、すぐ始める */
  setAutoDownload(on: boolean): void {
    this.deps.setAutoDownload(on)
    this.emit()
    if (on) void this.download()
  }

  /**
   * 裏でダウンロードし、署名で確かめた大きさ・sha256 と合えば「準備ができた」にする。
   * 入れ替えのファイルが無い・できない起動では何もしない（false）。同じ版を落としている・落とし終えていれば、そのまま
   */
  async download(): Promise<boolean> {
    if (!this.supported() || this.installing) return false
    const method = this.deps.method!
    const file = this.target()
    if (!file) return false
    const p = this.progress
    if ((p.phase === 'downloading' || p.phase === 'ready') && p.version === file.version) return true
    this.downloadAbort?.abort()
    const abort = new AbortController()
    this.downloadAbort = abort
    this.downloaded = null
    this.set({ phase: 'downloading', version: file.version, percent: 0 })
    try {
      const { dir, target } = await this.deps.prepareDir(file.name)
      // 前の起動で落として確かめたものが残っていれば、もう一度確かめて使う
      let path: string
      if ((await this.deps.hashFile(target)) === file.sha256) {
        path = target
      } else {
        let last = 0
        path = await this.deps.download(file, dir, (received, total) => {
          const percent = Math.min(100, Math.floor((received / Math.max(1, total)) * 100))
          if (percent !== last && !abort.signal.aborted) {
            last = percent
            this.set({ phase: 'downloading', version: file.version, percent })
          }
        }, abort.signal)
      }
      if (abort.signal.aborted) return false
      // 入れ替えの準備（macOS は Squirrel.Mac に渡して受け取り終えるまで）。E2E・開発版は本物の入れ替えをしないので渡さない
      if (this.deps.canInstall) {
        this.set({ phase: 'downloading', version: file.version, percent: 100 })
        await this.deps.stage(method, path, file)
      }
      if (abort.signal.aborted) return false
      this.downloaded = { path, file }
      this.set({ phase: 'ready', version: file.version, action: method === 'deb' ? 'open-installer' : 'restart' })
      return true
    } catch (err) {
      if (abort.signal.aborted) return false
      this.deps.report(err, `auto update: ${method}`)
      this.set({ phase: 'failed', version: file.version, message: this.deps.failedMessage() })
      return false
    } finally {
      if (this.downloadAbort === abort) this.downloadAbort = null
    }
  }

  /**
   * 入れ替える（「再起動して更新」/ deb は「インストーラーを開く」）。準備ができていなければ false。
   * 本物の入れ替えをしない起動（E2E・開発版）では、何もせず false
   */
  async install(): Promise<boolean> {
    const method = this.deps.method
    if (!method || !this.downloaded || this.progress.phase !== 'ready' || this.installing) return false
    if (!this.deps.canInstall) return false
    const { path, file } = this.downloaded
    // deb は開くだけなので、何度でも押せる。ほかは入れ替えが始まったら二度押さない
    if (method !== 'deb') this.installing = true
    try {
      await this.deps.install(method, path, file)
      return true
    } catch (err) {
      this.installing = false
      this.deps.report(err, `auto update install: ${method}`)
      this.set({ phase: 'failed', version: file.version, message: this.deps.failedMessage() })
      return false
    }
  }
}
