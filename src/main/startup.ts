/**
 * 起動時間の計測（NF-5: 起動から操作可能まで2秒以内）。
 *
 * 基準はプロセス生成時刻。Electron の `process.getCreationTime()` は
 * 3つのOSで利用できるが、取得できない場合はモジュール読み込み時刻へ退避する。
 */
import { reportPerf } from '@shared/report'
import { SLOW_STARTUP_MS } from '@shared/telemetry'
import { slowStartupReport, startupBreakdown } from '@shared/startupBreakdown'

const moduleLoadedAt = Date.now()

function processCreationTime(): number | null {
  try {
    const creation = (process as NodeJS.Process & { getCreationTime?: () => number | null })
      .getCreationTime?.()
    return typeof creation === 'number' && creation > 0 ? creation : null
  } catch {
    return null
  }
}

const creationTime = processCreationTime()
const origin = creationTime ?? moduleLoadedAt
const marks: Record<string, number> = {}

/** 節目を記録する。値はプロセス生成からの経過ミリ秒 */
export function mark(name: string): number {
  const elapsed = Math.round(Date.now() - origin)
  marks[name] = elapsed
  return elapsed
}

function marksSnapshot(): Record<string, number> {
  return { ...marks }
}

export function elapsedMs(): number {
  return Math.round(Date.now() - origin)
}

let reported = false

/** 性能の報告に付けるタグ（エミュレーションで動いているかなど）。main が起動の早いうちに渡す */
let startupTags: Record<string, string> = {}

export function setStartupTags(tags: Record<string, string>): void {
  startupTags = { ...tags }
}

/**
 * renderer から「操作可能になった」通知を受けた時点で1度だけログへ出す。
 * 目標未達のときは警告にして、原因の切り分けに内訳を併記する。
 */
export function reportInteractive(): { totalMs: number; marks: Record<string, number> } {
  const totalMs = mark('interactive')
  if (!reported) {
    reported = true
    const breakdown = Object.entries(marksSnapshot())
      .sort((a, b) => a[1] - b[1])
      .map(([name, ms]) => `${name}=${ms}ms`)
      .join(' ')
    const line = `[startup] 操作可能まで ${totalMs}ms (目標 2000ms) | ${breakdown}`
    if (totalMs > 2000) console.warn(`${line} ← 目標未達`)
    else console.log(line)
    // 目標を大きく超えたら Sentry へ warning を1件（1回の起動で1度だけ。内訳の名前と時間だけを付ける）。
    // JS より後の遅れだけを slow-startup として数え、JS より前（Gatekeeper の検査・dyld など）で超えたものは slow-pre-js に分ける
    const timing = startupBreakdown({ totalMs, origin, moduleLoadedAt, originSource: creationTime === null ? 'module' : 'process', marks: marksSnapshot() })
    const slow = slowStartupReport(timing, SLOW_STARTUP_MS)
    if (slow) reportPerf(slow.perf, slow.ms, { tags: { ...startupTags, ...timing.tags }, context: timing.context })
  }
  return { totalMs, marks: marksSnapshot() }
}
