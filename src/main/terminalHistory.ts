/**
 * ターミナルの直近の出力（スクロールバック）を覚えておく。画面を読み込み直した（⌘R・HMR）あと、
 * つなぎ直したタブに描き直すために使う。
 *
 * Orca由来の考え方: ~/bench/orca/src/shared/terminal-tab-types.ts（TerminalLayoutSnapshot の
 * ptyIdsByLeafId「同じセッションの中での再マウントでは、生きている PTY につなぎ直す」）,
 * ~/bench/orca/src/main/daemon（セッションを残し、画面の再接続時に内容を戻す）（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca は常駐のデーモンが画面の内容を擬似端末で持ち、整えた形で返す。本システムは main が PTY を持ち続けるので、
 * 生の出力を上限つきで覚えておき、それを流し直す。途中から切ると制御シーケンスの途中になることがあるので、
 * 切ったときは最初の改行の後ろから返す（CSI などの制御シーケンスは改行を含まない）。
 * 流し直したあとは、Agent などの全画面の TUI に描き直してもらう（renderer がサイズを一度揺らす）。
 */

/** 覚えておく上限（文字数）。Claude Code / Codex の1画面分の描き直しを十分に含む */
export const TERMINAL_HISTORY_LIMIT = 512 * 1024

export class TerminalHistory {
  private chunks: string[] = []
  private size = 0
  private truncated = false

  constructor(private readonly limit = TERMINAL_HISTORY_LIMIT) {}

  push(data: string): void {
    if (!data) return
    this.chunks.push(data)
    this.size += data.length
    while (this.size > this.limit && this.chunks.length > 0) {
      const head = this.chunks[0]!
      const over = this.size - this.limit
      if (head.length <= over) {
        this.chunks.shift()
        this.size -= head.length
      } else {
        this.chunks[0] = head.slice(over)
        this.size -= over
      }
      this.truncated = true
    }
  }

  /** 流し直す内容。古い側を切っていれば、最初の改行の後ろから */
  snapshot(): string {
    const text = this.chunks.join('')
    if (!this.truncated) return text
    const newline = text.indexOf('\n')
    return newline === -1 ? '' : text.slice(newline + 1)
  }
}
