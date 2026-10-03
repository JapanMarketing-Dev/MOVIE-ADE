/**
 * 録画の時計（設計4章「同じ時計＝録画開始からのミリ秒」）。
 *
 * 一時停止した分は進めない。動画・静止画・音声・操作ログのすべてが
 * この1つの時計を見るので、系統ごとのずれが生まれない。
 * プロセスをまたぐ（録画用ウィンドウ・注入スクリプト）場合も、
 * 各プロセスの `Date.now()` と `startedAtEpoch` の差で同じ値を出せる。
 */
export class RecordingClock {
  /** 録画開始の実時刻（epoch ms）。他プロセスへ渡して時刻を揃える */
  readonly startedAtEpoch: number
  private accumulated = 0
  private resumedAt: number | null

  constructor(now: number = Date.now()) {
    this.startedAtEpoch = now
    this.resumedAt = now
  }

  /** 録画開始からの経過(ms)。一時停止中は進まない */
  now(at: number = Date.now()): number {
    if (this.resumedAt === null) return this.accumulated
    return this.accumulated + (at - this.resumedAt)
  }

  /** 他プロセスの epoch ms を、この時計の値へ直す */
  fromEpoch(epochMs: number): number {
    if (this.resumedAt === null) return this.accumulated
    return this.accumulated + (epochMs - this.resumedAt)
  }

  pause(at: number = Date.now()): void {
    if (this.resumedAt === null) return
    this.accumulated += at - this.resumedAt
    this.resumedAt = null
  }

  resume(at: number = Date.now()): void {
    if (this.resumedAt !== null) return
    this.resumedAt = at
  }

  get paused(): boolean {
    return this.resumedAt === null
  }
}
