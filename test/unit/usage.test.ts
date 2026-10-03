import { describe, expect, it, vi } from 'vitest'

// fetchers は credentials → accounts/identity を読むが、electron は使わない。念のため塞いでおく
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

import {
  formatPlanLabel,
  formatResetCountdown,
  formatResetDuration,
  formatWindowChipLabel,
  soonestResetLabel,
  tightestUsageSection,
  usageSections,
  usageTone,
  type ProviderRateLimits
} from '../../src/shared/usage'
import { mapClaudeUsageResponse, mapCodexUsageResponse, parseResetTimestamp } from '../../src/main/usage/fetchers'
import {
  MIN_REFETCH_MS,
  STALE_THRESHOLD_MS,
  applyStalePolicy,
  failureRetryDelayMs,
  providersToRefresh,
  withFetchingStatus
} from '../../src/main/usage/policy'

const NOW = 1_800_000_000_000

function ok(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 29, windowMinutes: 300, resetsAt: NOW + (3 * 60 + 5) * 60_000 },
    weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: NOW + 4 * 24 * 3_600_000 },
    updatedAt: NOW,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('表示用の書式（Orca と同じ）', () => {
  it('残り時間', () => {
    expect(formatResetDuration(0)).toBe('now')
    expect(formatResetDuration(45 * 60_000)).toBe('45m')
    expect(formatResetDuration((3 * 60 + 5) * 60_000)).toBe('3h 5m')
    expect(formatResetDuration((6 * 24 + 23) * 3_600_000)).toBe('6d 23h')
    expect(formatResetDuration(4 * 24 * 3_600_000)).toBe('4d')
    expect(formatResetCountdown((3 * 60 + 5) * 60_000)).toBe('Resets in 3h 5m')
  })

  it('フッターの枠の名前は残り時間、分からなければ枠の長さ', () => {
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 300, resetsAt: NOW + 3_600_000 }, NOW)).toBe('1h')
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 10080, resetsAt: null }, NOW)).toBe('wk')
  })

  it('枠の並び・いちばん使っている枠・いちばん早い戻り', () => {
    const p = ok({ fableWeekly: { usedPercent: 3, windowMinutes: 10080, resetsAt: null } })
    expect(usageSections(p).map((s) => s.label)).toEqual(['5h', 'wk', 'Fable'])
    expect(tightestUsageSection(p)?.key).toBe('session')
    expect(soonestResetLabel(p, NOW)).toBe('Resets in 3h 5m')
  })

  it('色の閾値は 60 / 80', () => {
    expect(usageTone(59)).toBe('normal')
    expect(usageTone(60)).toBe('warning')
    expect(usageTone(80)).toBe('urgent')
  })

  it('プラン名', () => {
    expect(formatPlanLabel('plus')).toBe('Plus')
    expect(formatPlanLabel('chatgpt_business')).toBe('ChatGPT Business')
    expect(formatPlanLabel('')).toBeNull()
  })
})

describe('Claude の応答の読み取り', () => {
  it('5時間・週・Fable（limits[] 形式）を読む', () => {
    const p = mapClaudeUsageResponse({
      five_hour: { utilization: 29, resets_at: '2027-01-15T08:00:00Z' },
      seven_day: { utilization: 10, resets_at: 1_800_000_000 },
      limits: [{ kind: 'weekly_scoped', percent: 3, resets_at: 1_800_000_000, scope: { model: { display_name: 'Fable' } } }]
    })
    expect(p.session).toEqual({ usedPercent: 29, windowMinutes: 300, resetsAt: Date.parse('2027-01-15T08:00:00Z') })
    expect(p.weekly?.resetsAt).toBe(1_800_000_000_000)
    expect(p.fableWeekly?.usedPercent).toBe(3)
    expect(p.status).toBe('ok')
  })

  it('古いキー名の Fable と、範囲外の値を丸める', () => {
    const p = mapClaudeUsageResponse({ five_hour: { used_percentage: 140 }, seven_day_fable: { utilization: -5 } })
    expect(p.session?.usedPercent).toBe(100)
    expect(p.weekly).toBeNull()
    expect(p.fableWeekly?.usedPercent).toBe(0)
  })

  it('戻る時刻は秒・ミリ秒・文字列のどれでも受ける', () => {
    expect(parseResetTimestamp(1_800_000_000)).toBe(1_800_000_000_000)
    expect(parseResetTimestamp(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(parseResetTimestamp('1800000000')).toBe(1_800_000_000_000)
    expect(parseResetTimestamp('壊れた値')).toBeNull()
    expect(parseResetTimestamp(undefined)).toBeNull()
  })
})

describe('Codex の応答の読み取り', () => {
  it('枠の長さで 5時間・週を見分ける（順番が逆でも）', () => {
    const p = mapCodexUsageResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1_800_000_100 }
      }
    })!
    expect(p.weekly).toEqual({ usedPercent: 0, windowMinutes: 10080, resetsAt: 1_800_000_000_000 })
    expect(p.session?.usedPercent).toBe(12)
    expect(p.planType).toBe('plus')
  })

  it('週の枠しか無いプランは週だけ', () => {
    const p = mapCodexUsageResponse({ plan_type: 'free', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } } })!
    expect(p.session).toBeNull()
    expect(p.weekly?.usedPercent).toBe(5)
  })

  it('plan_type が無い応答は使わない', () => {
    expect(mapCodexUsageResponse({ rate_limit: null })).toBeNull()
  })
})

describe('取得の頻度と失敗時の表示（Orca と同じ）', () => {
  const failed = (extra: Partial<ProviderRateLimits> = {}): ProviderRateLimits => ({
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: NOW,
    error: '通信できません',
    status: 'error',
    failureKind: 'network',
    ...extra
  })

  it('失敗しても、30分以内の成功値は出したまま状態だけ error にする', () => {
    const previous = ok({ updatedAt: NOW - 60_000 })
    const shown = applyStalePolicy(failed(), previous, NOW)
    expect(shown.status).toBe('error')
    expect(shown.session?.usedPercent).toBe(29)
    expect(shown.error).toBe('通信できません')
  })

  it('古すぎる成功値は出さない（取得制限中は24時間まで残す）', () => {
    const previous = ok({ updatedAt: NOW - STALE_THRESHOLD_MS - 1 })
    expect(applyStalePolicy(failed(), previous, NOW).session).toBeNull()
    expect(applyStalePolicy(failed({ failureKind: 'rate-limited' }), previous, NOW).session?.usedPercent).toBe(29)
  })

  it('取得中も、出ている値は出したまま', () => {
    expect(withFetchingStatus(null, 'codex').status).toBe('fetching')
    const current = ok()
    expect(withFetchingStatus(current, 'claude')).toBe(current)
  })

  it('失敗の再試行は 30秒から倍々で、15分で止まる', () => {
    expect(failureRetryDelayMs(1)).toBe(30_000)
    expect(failureRetryDelayMs(2)).toBe(60_000)
    expect(failureRetryDelayMs(10)).toBe(15 * 60_000)
  })

  it('窓が前に出たとき：値なし・5分たった成功・間隔をあけた失敗だけ取り直す', () => {
    const base = { lastFailureRetryAt: { claude: 0, codex: 0 }, failureStreak: { claude: 0, codex: 0 }, now: NOW }
    expect(providersToRefresh({ ...base, state: { claude: null, codex: ok({ provider: 'codex' }) } })).toEqual(['claude'])
    expect(providersToRefresh({ ...base, state: { claude: ok({ updatedAt: NOW - MIN_REFETCH_MS }), codex: null } })).toEqual(['claude', 'codex'])
    // Retry-After の間は取りに行かない
    expect(providersToRefresh({ ...base, state: { claude: failed({ retryAtMs: NOW + 1000 }), codex: ok({ provider: 'codex' }) } })).toEqual([])
    // 直前に失敗して再試行したばかりなら待つ
    expect(
      providersToRefresh({
        ...base,
        lastFailureRetryAt: { claude: NOW - 10_000, codex: 0 },
        failureStreak: { claude: 1, codex: 0 },
        state: { claude: failed(), codex: ok({ provider: 'codex' }) }
      })
    ).toEqual([])
  })
})

describe('フッターが狭いときの段階', async () => {
  const { pickUsageDensityLevel, segmentDetail } = await import('../../src/renderer/lib/usageDensity')

  it('広い順に「used」→ 副次の枠 → ラベル → バーを省く', () => {
    expect(segmentDetail('verbose', 0)).toEqual({ used: true, secondary: true, labels: true, bar: true, allSections: true })
    expect(segmentDetail('verbose', 1)).toMatchObject({ used: false, secondary: true })
    expect(segmentDetail('verbose', 2)).toMatchObject({ used: false, secondary: false, labels: true })
    expect(segmentDetail('verbose', 3)).toEqual({ used: false, secondary: false, labels: false, bar: true, allSections: false })
    expect(segmentDetail('verbose', 4).bar).toBe(false)
    expect(segmentDetail('compact', 0)).toMatchObject({ used: true, allSections: false, bar: false })
  })

  it('収まるいちばん広い段階を選び、測っていない段階はいったん試す', () => {
    expect(pickUsageDensityLevel([], 100)).toBe(0)
    expect(pickUsageDensityLevel([500], 300)).toBe(1)
    expect(pickUsageDensityLevel([500, 400, 280], 300)).toBe(2)
    expect(pickUsageDensityLevel([500, 400, 350, 320, 200], 100)).toBe(4)
    expect(pickUsageDensityLevel([300.5], 300)).toBe(0)
  })
})
