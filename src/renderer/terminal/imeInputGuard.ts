/**
 * IME で確定した文字が PTY へ2回送られるのを防ぐ。
 *
 * xterm.js 5.5 は確定した文字を2つの経路で送ることがある:
 *  1. CompositionHelper: compositionend のあと setTimeout(0) で textarea の差分を送る
 *  2. Terminal._inputEvent: inputType が 'insertText' の input イベントを、直前に keydown が
 *     無かった（keyup 済み）とき送る
 * macOS の日本語 IME（ライブ変換・Google 日本語入力など）や Windows の IME は、確定を
 * keyup のあとの insertText として届けることがあり、そのとき 1 と 2 の両方が同じ文字を送る。
 * どちらが先に来るかは IME と OS で変わるので、送る直前（onData）で同じ確定文字の2回目だけを落とす。
 *
 * 1回の変換（compositionstart から compositionend の少しあとまで）で IME が確定するのは1回だけ。
 * そのあいだに同じ文字列が2回来たら2回目は重複とみなす。変換の外の打鍵・貼り付けには触らない。
 *
 * 韓国語の IME は、次の音節の変換が始まってから前の音節の確定を送る。変換中に届いた文字は、同じ文字の重複だけを落とし、
 * 「確定文字＋続けて打った文字」の前方一致には使わない。使うと、同じ音節が続いて句読点で確定したとき（ㅋㅋ. など）に、
 * 今の変換の確定「ㅋ.」の頭が前の音節の重複とみなされて消える（Orca #24663）。
 */

/** compositionend のあと、遅れて届く2つ目の送信を待つ時間。どちらも数ミリ秒以内に来る */
export const IME_DUPLICATE_WINDOW_MS = 100

export class ImeInputGuard {
  private composing = false
  /** 変換が終わった時刻。null は変換の外 */
  private endedAt: number | null = null
  /** この変換で compositionend のあとに送った文字列（重複と前方一致の両方に使う） */
  private sent: string[] = []
  /** この変換の最中に送った文字列（Windows の先に届く insertText、韓国語の前の音節の確定）。重複にだけ使う */
  private early: string[] = []
  /** 1つ前の変換で送った文字列。次の変換の最中に遅れて届く同じ確定を落とす */
  private previous: string[] = []

  constructor(private readonly windowMs = IME_DUPLICATE_WINDOW_MS) {}

  compositionStart(): void {
    // 変換の最中に届いた分（early）は前の音節の確定のことがあるので持ち越さない（ㅋㅋㅋ の3つ目が消える）
    this.previous = this.endedAt !== null ? this.sent : []
    this.composing = true
    this.endedAt = null
    this.sent = []
    this.early = []
  }

  compositionEnd(now: number): void {
    this.composing = false
    this.endedAt = now
  }

  /** 変換と関係のない打鍵（keyCode 229 でも変換中でもない keydown）が来たら、変換の区切りを閉じる */
  keyDown(event: { isComposing: boolean; keyCode: number }): void {
    if (this.composing || event.isComposing || event.keyCode === 229) return
    this.close()
  }

  /**
   * PTY へ送る分を返す。同じ確定文字の2回目は ''（送らない）。
   * 先に確定文字だけが送られ、あとから「確定文字＋続けて打った文字」がまとめて来たときは、続きの分だけを返す
   */
  filter(data: string, now: number): string {
    if (!this.inSession(now)) {
      this.close()
      return data
    }
    if (data.length === 0) return data
    if (this.composing) {
      if (this.early.includes(data) || this.previous.includes(data)) return ''
      this.early.push(data)
      return data
    }
    if (this.sent.includes(data) || this.early.includes(data)) return ''
    const prefix = this.sent.find((sent) => sent.length > 0 && data.startsWith(sent))
    const rest = prefix ? data.slice(prefix.length) : data
    this.sent.push(data)
    return rest
  }

  private inSession(now: number): boolean {
    if (this.composing) return true
    return this.endedAt !== null && now - this.endedAt <= this.windowMs
  }

  private close(): void {
    this.endedAt = null
    this.sent = []
    this.early = []
    this.previous = []
  }
}
