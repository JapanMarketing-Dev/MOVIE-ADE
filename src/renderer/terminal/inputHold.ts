/**
 * PTY へ送る入力の順番を保つ（純粋なロジック。単体テストの対象）。
 *
 * Shift+Enter で送るキー列は、前面の Agent をその場で問い合わせてから決まることがある（terminalClient.ts）。
 * その返事を待つ間に打ったキーを先に送ると順番が入れ替わるので、決まるまでためて、決まったら続けて1回で送る。
 * 待つものが無いときはそのまま送る。渡す Promise は失敗しないこと（呼ぶ側で既定の値に倒す）
 */
export class InputHold {
  private readonly queue: Array<string | Promise<string>> = []
  private draining = false

  constructor(private readonly write: (data: string) => void) {}

  send(data: string | Promise<string>): void {
    if (typeof data === 'string' && this.queue.length === 0) {
      if (data) this.write(data)
      return
    }
    this.queue.push(data)
    void this.drain()
  }

  /** 返事を待っている入力があるか */
  get holding(): boolean {
    return this.queue.length > 0
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const head = this.queue[0]
        let out = typeof head === 'string' ? head : await head
        this.queue.shift()
        while (this.queue.length > 0 && typeof this.queue[0] === 'string') out += this.queue.shift() as string
        if (out) this.write(out)
      }
    } finally {
      this.draining = false
    }
  }
}
