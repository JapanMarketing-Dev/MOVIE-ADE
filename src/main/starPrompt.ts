import {
  DEFAULT_STAR_PROMPT,
  blockedReason,
  countEvent,
  isMoment,
  type StarActionResult,
  type StarPromptContext,
  type StarPromptMode,
  type StarPromptMoment,
  type StarPromptState
} from '@shared/starPrompt'

/**
 * 「GitHub で star を」のお願いを、いつ出すかを決めて、押されたことを処理する。
 *
 * Orca由来: ~/bench/orca/src/main/star-nag/service.ts の StarNagService（maybeShow・markCompleted・openWeb・starOrcaFromNag）（MIT, Copyright 2026 Lovecast Inc.）
 * Orca との違い:
 *   - 場面は「最初に Agent へ送れたとき」と「完成したレビューが 3・10・30 件になったとき」
 *   - 録画中・セットアップ中は出さない。生涯の表示回数にも上限を置く
 *   - 出した時点で回数と時刻を残す（閉じずにアプリを終えても、次の 3 日は出さない）
 *   - 結果のテレメトリは送らない
 * Electron に依存させない（状態の読み書き・gh・画面への通知は呼び出し側が渡す）。単体テストの対象。
 */

export interface StarPromptDeps {
  getState: () => StarPromptState | undefined
  setState: (state: StarPromptState) => void
  context: () => Omit<StarPromptContext, 'now'>
  now?: () => number
  checkStarred: () => Promise<boolean | null>
  starRepo: () => Promise<boolean>
  openRepo: () => Promise<void>
  /** 画面にトーストを出す。届けられなければ false */
  show: (mode: StarPromptMode) => boolean
}

export class StarPromptService {
  /** 調べている間に次の出来事が来ても、gh を重ねて走らせない */
  private evaluating = false
  private visible = false

  constructor(private readonly deps: StarPromptDeps) {}

  private get state(): StarPromptState {
    return this.deps.getState() ?? DEFAULT_STAR_PROMPT
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** 出来事を数え、良い場面なら（条件を満たせば）お願いを出す。出したら true */
  async record(moment: StarPromptMoment): Promise<boolean> {
    const counted = countEvent(this.state, moment)
    this.deps.setState(counted)
    if (!isMoment(counted, moment) || this.visible || this.evaluating) return false
    if (blockedReason(counted, { ...this.deps.context(), now: this.now() })) return false
    this.evaluating = true
    try {
      const starred = await this.deps.checkStarred()
      if (starred) {
        // ほかで star 済み。二度と聞かない
        this.markDone()
        return false
      }
      // 調べている間に録画が始まった・ほかで done になった、なら出さない
      if (blockedReason(this.state, { ...this.deps.context(), now: this.now() })) return false
      if (!this.deps.show(starred === null ? 'web' : 'gh')) return false
      const latest = this.state
      this.deps.setState({ ...latest, count: latest.count + 1, lastShownAt: this.now() })
      this.visible = true
      return true
    } finally {
      this.evaluating = false
    }
  }

  /** トーストの「Star」。gh で star し、できなければ false（画面はブラウザで開く案内に切り替える） */
  async star(): Promise<boolean> {
    const ok = await this.deps.starRepo()
    if (ok) this.markDone()
    return ok
  }

  /** ブラウザで開く。star できたかは分からないので done にはしない（次の場面まで待つだけ） */
  async openWeb(): Promise<void> {
    this.visible = false
    await this.deps.openRepo()
  }

  /** 「あとで」。出した時点でクールダウンは始まっているので、閉じるだけ */
  later(): void {
    this.visible = false
  }

  /** 「今後表示しない」 */
  never(): void {
    this.markDone()
  }

  /**
   * 設定の「この Ferret について」とヘルプのメニューからの star（いつでも押せる入口）。
   * gh で star できればそうし、gh が使えない・失敗したらブラウザで開く。すでに star 済みなら何もしない。
   */
  async starFromMenu(): Promise<StarActionResult> {
    const starred = await this.deps.checkStarred()
    if (starred) {
      this.markDone()
      return 'starred'
    }
    if (starred === false && await this.star()) return 'starred'
    try {
      await this.deps.openRepo()
      return 'opened'
    } catch {
      return 'failed'
    }
  }

  private markDone(): void {
    this.deps.setState({ ...this.state, done: true })
    this.visible = false
  }
}
