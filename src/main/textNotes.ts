import { ipcMain, type WebContents } from 'electron'
import { NOTE_CHANNELS } from '@shared/textNote'
import type { AnnotationColor } from '@shared/annotation'
import { newNoteId, sanitizeTextNote, type NotePage, type TextNote } from './sessions/notes'
import { redactUrl } from './pipeline/redact'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'

/**
 * 文字で指摘（エディタの内蔵ブラウザ・映したウインドウで、枠を引いて指示を打つ。録画しない）の受け口。
 *
 * 流れ: renderer のツールバーの［文字で指摘］→ setActive → 注入スクリプト（preload/review.ts）へ { type: 'note', enable } を送る
 *       → 利用者が枠を引いて打ち、Enter → 注入側が欄を隠して NOTE_CHANNELS.submit で送る
 *       → ここで送り主（いま見えているビュー）・モード・録画中でないことを確かめ、値を整える
 *       → index.ts の capture が、そのビューへの直前の本物の入力の許可を使ってから1枚撮る（ViewInputGrant）
 *       → 開いているレビューへ足す・無ければ新しいレビュー（review.ts の addTextNote）→ 注入側へ結果を返し、renderer へ知らせる
 *
 * 録画の書き込み（RecordingController の ade-review:event）とは別のチャネル・別のモード。録画中は使えない（録画を始めたら切る）。
 */

const REVIEW_COMMAND = 'ade-review:command'
const REVIEW_READY = 'ade-review:ready'

/** 撮った静止画（PNG）。false はそのビューで直前に本物の入力が無かった（撮らない） */
export type NoteCapture = { png: Uint8Array; size: { width: number; height: number } } | null | false

interface TextNoteDeps {
  /** 内蔵ブラウザのビューと、その場所に映しているウインドウのビュー */
  views(): { browser: WebContents | null; mirror: WebContents | null }
  recording(): boolean
  /** そのビューへの直前の本物の入力の許可を使ってから1枚撮る（index.ts。撮る処理は決めた場所にだけ置く） */
  capture(view: WebContents): Promise<NoteCapture>
  /** 開いているレビュー（reviewId）へ足す・無ければ新しいレビュー。mirrored は映したウインドウの上で打ったか */
  save(request: { id: string; note: TextNote; image: Exclude<NoteCapture, false>; page?: NotePage }, reviewId: string | null, mirrored: boolean): Promise<{ review: { id: string }; count: number }>
  color(): AnnotationColor
  labels(): Record<'placeholder' | 'hint' | 'add', string>
  /** モードが main 側で変わった（ページの Esc・録画の開始） */
  onMode(active: boolean): void
  onAdded(result: { review: { id: string }; count: number }): void
  onError(err: unknown): void
}

export class TextNotes {
  private active = false
  /** 足し先のレビュー（Findings で開いているもの）。無ければ最初の1件で新しく作り、以降はそこへ足す */
  private reviewId: string | null = null
  private saving: Promise<unknown> = Promise.resolve()
  private bound = false

  constructor(private readonly deps: TextNoteDeps) {}

  bind(): void {
    if (this.bound) return
    this.bound = true
    ipcMain.on(NOTE_CHANNELS.submit, (event, raw: unknown) => void this.submit(event.sender, raw))
    ipcMain.on(NOTE_CHANNELS.exit, (event) => {
      if (this.active && event.sender === this.current()) this.setActive(false, { notify: true })
    })
    // 遷移・映し直しで注入スクリプトが読み直されたら、いまのモードを送り直す
    ipcMain.on(REVIEW_READY, (event) => {
      if (this.isView(event.sender)) this.push(event.sender)
    })
  }

  get isActive(): boolean {
    return this.active
  }

  /**
   * 文字で指摘の入・切。録画中は入にしない。reviewId を渡したら足し先も変える（null は新しいレビュー）。
   * 実際の状態を返す
   */
  setActive(on: boolean, options: { reviewId?: string | null; notify?: boolean } = {}): boolean {
    const next = on && !this.deps.recording()
    if (options.reviewId !== undefined) this.reviewId = options.reviewId
    const changed = next !== this.active
    this.active = next
    // 内蔵ブラウザと映したビューの両方へ送る（映したビューが消えたら、内蔵ブラウザで続けられる）
    for (const view of this.allViews()) this.push(view)
    if (options.notify && changed) this.deps.onMode(next)
    return next
  }

  /** 色を変えた。描いてある枠はそのまま、次の枠から */
  refreshColor(): void {
    if (this.active) for (const view of this.allViews()) this.push(view)
  }

  /** いま見えているビュー（映していればそちら） */
  private current(): WebContents | null {
    const { browser, mirror } = this.deps.views()
    if (mirror && !mirror.isDestroyed()) return mirror
    return browser && !browser.isDestroyed() ? browser : null
  }

  private allViews(): WebContents[] {
    const { browser, mirror } = this.deps.views()
    return [browser, mirror].filter((wc): wc is WebContents => !!wc && !wc.isDestroyed())
  }

  private isView(sender: unknown): sender is WebContents {
    const { browser, mirror } = this.deps.views()
    return !!sender && (sender === browser || sender === mirror)
  }

  private push(view: WebContents): void {
    if (view.isDestroyed()) return
    view.send(REVIEW_COMMAND, this.active ? { type: 'note', enable: true, color: this.deps.color(), labels: this.deps.labels() } : { type: 'note', enable: false })
  }

  private reply(view: WebContents, ok: boolean): void {
    if (!view.isDestroyed()) view.send(REVIEW_COMMAND, { type: 'noteResult', ok })
  }

  private async submit(sender: WebContents, raw: unknown): Promise<void> {
    // いま見えているビューから、文字で指摘が入のときだけ受ける（隠れたビュー・録画中・ページのスクリプトからの送りつけは捨てる）
    if (!this.active || this.deps.recording() || sender !== this.current()) return void (this.isView(sender) && this.reply(sender, false))
    const note = sanitizeTextNote(raw)
    if (!note) return this.reply(sender, false)
    const mirrored = sender === this.deps.views().mirror
    let image: NoteCapture
    try {
      image = await this.deps.capture(sender)
    } catch (err) {
      this.deps.onError(err)
      image = null
    }
    if (image === false) {
      // 直前にそのビューで本物の入力が無い（Enter・ボタンの押下より前に届いた・古い）。撮らずに断る
      this.reply(sender, false)
      this.deps.onError(new UserFacingError(t('textNote.errors.needsEnter')))
      return
    }
    const url = sender.isDestroyed() ? '' : sender.getURL()
    const page = !mirrored && url && url !== 'about:blank' ? { url: redactUrl(url), title: sender.getTitle() } : undefined
    const request = { id: newNoteId(), note, image, ...(page ? { page } : {}) }
    // 同じレビューへ続けて足すので1件ずつ
    const work = this.saving.catch(() => undefined).then(async () => {
      try {
        const result = await this.deps.save(request, this.reviewId, mirrored)
        this.reviewId = result.review.id
        this.reply(sender, true)
        this.deps.onAdded(result)
      } catch (err) {
        this.reply(sender, false)
        this.deps.onError(err)
      }
    })
    this.saving = work
    await work
  }
}
