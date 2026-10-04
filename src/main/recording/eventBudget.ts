/**
 * 注入スクリプトから届く操作ログ・書き込み・キーの、頻度と総量の上限（設計4章。CWE-400 への備え）。
 *
 * レビュー対象は任意のページなので、ページのスクリプトが合成のクリックやスクロールを大量に起こすと、
 * 操作ログ（メモリと events.jsonl）と、クリックのたびの強制撮影が際限なく増えうる。
 * 注入スクリプトは isTrusted でない入力を捨てるが、main 側でも次の上限で受け止める:
 * - 種類ごとの頻度（トークンバケット。人の操作の速さに余裕を持たせた値）
 * - 1回の録画で記録する操作ログの件数
 * 上限を超えたものは捨て、録画は続ける。超えたことは呼び出し側が1度だけ利用者へ知らせる。
 *
 * Electron に依存しない純粋な処理だけを置く（時計は差し替えられる）。
 */

export type ReviewInputKind = 'click' | 'scroll' | 'pen' | 'erase' | 'nav' | 'pointer' | 'shortcut' | 'history'

interface RateLimit {
  /** 続けて受け付けられる数 */
  capacity: number
  /** 1秒あたりに戻る数 */
  perSecond: number
}

interface ReviewEventLimits {
  rates: Record<ReviewInputKind, RateLimit>
  /** 1回の録画で記録する操作ログの上限（pointer・shortcut・history は記録しないので数えない） */
  maxEvents: number
}

export const DEFAULT_REVIEW_EVENT_LIMITS: ReviewEventLimits = {
  rates: {
    // 人のクリックは速くても毎秒数回。ダブルクリックや連打の分の余裕を持たせる
    click: { capacity: 10, perSecond: 5 },
    // 注入側で 200ms ごとに間引いている
    scroll: { capacity: 10, perSecond: 5 },
    // 描く・動かす・元に戻す（キーの押しっぱなしは注入側で捨てる）
    pen: { capacity: 20, perSecond: 10 },
    erase: { capacity: 20, perSecond: 10 },
    // ページ内の遷移（pushState・ハッシュ）。リダイレクトが続く分の余裕を持たせる
    nav: { capacity: 20, perSecond: 5 },
    // カーソル位置（記録はしない。注入側で 100ms ごとに間引いている）
    pointer: { capacity: 20, perSecond: 15 },
    shortcut: { capacity: 10, perSecond: 10 },
    history: { capacity: 20, perSecond: 20 }
  },
  // 90分の録画で平均 3.7件/秒。ふつうの操作ではまず届かない
  maxEvents: 20_000
}

/** 受け付けたか。rate は頻度の上限、total は総量の上限で捨てた */
export type Admission = 'ok' | 'rate' | 'total'

const RECORDED: ReadonlySet<ReviewInputKind> = new Set(['click', 'scroll', 'pen', 'erase', 'nav'])

export class ReviewEventBudget {
  private readonly buckets = new Map<ReviewInputKind, { tokens: number; at: number }>()
  private recorded = 0

  constructor(
    private readonly limits: ReviewEventLimits = DEFAULT_REVIEW_EVENT_LIMITS,
    private readonly now: () => number = Date.now
  ) {}

  /** 1件受け付けてよいか。受け付けたら数える */
  admit(kind: ReviewInputKind): Admission {
    const recorded = RECORDED.has(kind)
    if (recorded && this.recorded >= this.limits.maxEvents) return 'total'
    if (!this.take(kind)) return 'rate'
    if (recorded) this.recorded++
    return 'ok'
  }

  /** 記録した操作ログの件数 */
  get recordedCount(): number {
    return this.recorded
  }

  private take(kind: ReviewInputKind): boolean {
    const limit = this.limits.rates[kind]
    const now = this.now()
    const bucket = this.buckets.get(kind) ?? { tokens: limit.capacity, at: now }
    bucket.tokens = Math.min(limit.capacity, bucket.tokens + ((now - bucket.at) / 1000) * limit.perSecond)
    bucket.at = now
    this.buckets.set(kind, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}
