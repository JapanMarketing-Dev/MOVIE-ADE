/**
 * 起動時間の計測（NF-5: 起動から操作可能まで2秒以内）。
 *
 * 基準はプロセス生成時刻。Electron の `process.getCreationTime()` は
 * 3つのOSで利用できるが、取得できない場合はモジュール読み込み時刻へ退避する。
 */
import { reportAnomaly } from '@shared/report'
import { SLOW_STARTUP_MS, durationBucket } from '@shared/telemetry'

const moduleLoadedAt = Date.now()

function processStartedAt(): number {
  const creation = (process as NodeJS.Process & { getCreationTime?: () => number | null })
    .getCreationTime?.()
  return typeof creation === 'number' && creation > 0 ? creation : moduleLoadedAt
}

const origin = processStartedAt()
const marks: Record<string, number> = {}

/** 節目を記録する。値はプロセス生成からの経過ミリ秒 */
export function mark(name: string): number {
  const elapsed = Math.round(Date.now() - origin)
  marks[name] = elapsed
  return elapsed
}

export function marksSnapshot(): Record<string, number> {
  return { ...marks }
}

export function elapsedMs(): number {
  return Math.round(Date.now() - origin)
}

let reported = false

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
    // 目標を大きく超えたら Sentry へ warning を1件（1回の起動で1度だけ。内訳の名前と時間だけを付ける）
    if (totalMs > SLOW_STARTUP_MS) reportAnomaly('slow startup', { kind: 'perf', perf: 'slow-startup', duration: durationBucket(totalMs) })
  }
  return { totalMs, marks: marksSnapshot() }
}
