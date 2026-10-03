import type { AccountAgent } from './types'
import { t } from './i18n'

/**
 * Claude Code / Codex の使用量（レート制限）。main / renderer が共有する型と、表示用の純粋関数。
 *
 * Orca由来: ~/bench/orca/src/shared/rate-limit-types.ts,
 *           ~/bench/orca/src/shared/rate-limit-reset-format.ts,
 *           ~/bench/orca/src/renderer/src/lib/window-label-formatter.ts,
 *           ~/bench/orca/src/renderer/src/components/status-bar/tooltip.tsx（getWindowSections / barColor の閾値）,
 *           ~/bench/orca/src/renderer/src/components/status-bar/UsageRosterPanel.tsx（getTightestUsageSection）（MIT, Copyright 2026 Lovecast Inc.）
 * Claude と Codex 以外の取得元（Gemini・Grok・Cursor など）と、月ごとの枠・バケットは持ち込んでいない。
 */

export interface RateLimitWindow {
  /** 枠の消費率（0〜100） */
  usedPercent: number
  /** 枠の長さ（分）。300 = 5時間、10080 = 1週間 */
  windowMinutes: number
  /** 枠が戻る時刻（Unix ms）。分からなければ null */
  resetsAt: number | null
}

export type ProviderRateLimitStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'

/** 失敗の種類（Orca の UsageRateLimitFailureKind のうち、本システムで起きるもの） */
export type UsageFailureKind = 'missing-credentials' | 'stale-token' | 'keychain-unavailable' | 'network' | 'server' | 'rate-limited' | 'unknown'

export interface ProviderRateLimits {
  provider: AccountAgent
  /** 5時間枠 */
  session: RateLimitWindow | null
  /** 1週間枠 */
  weekly: RateLimitWindow | null
  /** Claude のモデル別（Fable）の1週間枠 */
  fableWeekly?: RateLimitWindow | null
  /** Codex のプラン（plus など） */
  planType?: string | null
  /** 最後に取得に成功した時刻（Unix ms） */
  updatedAt: number
  /** 利用者向けの失敗理由。成功なら null */
  error: string | null
  status: ProviderRateLimitStatus
  failureKind?: UsageFailureKind
  /** この時刻（Unix ms）までは取り直さない（HTTP の Retry-After） */
  retryAtMs?: number
}

export type UsageState = Record<AccountAgent, ProviderRateLimits | null>

/** アカウント別の内訳の1行。accountId が null ならシステムの既定アカウント */
export interface AccountUsage {
  accountId: string | null
  label: string
  active: boolean
  rateLimits: ProviderRateLimits | null
}

/** 黄色・赤にする使用率（Orca と同じ 60 / 80） */
export const USAGE_WARNING_PERCENT = 60
export const USAGE_URGENT_PERCENT = 80

export function clampUsedPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)))
}

export type UsageTone = 'normal' | 'warning' | 'urgent'

export function usageTone(usedPercent: number): UsageTone {
  const used = clampUsedPercent(usedPercent)
  return used >= USAGE_URGENT_PERCENT ? 'urgent' : used >= USAGE_WARNING_PERCENT ? 'warning' : 'normal'
}

/** "3h 5m" / "6d 23h" / "now"（Orca の formatResetDuration と同じ） */
export function formatResetDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) return `${totalMins}m`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/** "Resets in 3h 54m" / "Resets now" */
export function formatResetCountdown(ms: number): string {
  const duration = formatResetDuration(ms)
  return duration === 'now' ? 'Resets now' : `Resets in ${duration}`
}

/** 枠の長さの短い名前（5h / wk など） */
export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 10080) return 'wk'
  if (windowMinutes === 300) return '5h'
  if (windowMinutes === 60) return '1h'
  if (windowMinutes < 60) return `${windowMinutes}m`
  if (windowMinutes % (60 * 24 * 7) === 0) return `${windowMinutes / (60 * 24 * 7)}wk`
  if (windowMinutes % (60 * 24) === 0) return `${windowMinutes / (60 * 24)}d`
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`
  return `${windowMinutes}m`
}

/** フッターの枠の名前。戻る時刻が分かれば残り時間、分からなければ枠の長さ */
export function formatWindowChipLabel(window: RateLimitWindow, now: number = Date.now()): string {
  return window.resetsAt != null ? formatResetDuration(window.resetsAt - now) : formatWindowLabel(window.windowMinutes)
}

export interface UsageSection {
  key: 'session' | 'weekly' | 'fableWeekly'
  /** 5h / wk / Fable */
  label: string
  window: RateLimitWindow
}

/** データのある枠だけを、5時間 → 週 → Fable の順に並べる */
export function usageSections(p: ProviderRateLimits): UsageSection[] {
  const sections: UsageSection[] = []
  if (p.session) sections.push({ key: 'session', label: formatWindowLabel(p.session.windowMinutes), window: p.session })
  if (p.weekly) sections.push({ key: 'weekly', label: formatWindowLabel(p.weekly.windowMinutes), window: p.weekly })
  if (p.fableWeekly) sections.push({ key: 'fableWeekly', label: 'Fable', window: p.fableWeekly })
  return sections
}

/** いちばん使っている枠（フッターが狭いときの表示とバーの色に使う） */
export function tightestUsageSection(p: ProviderRateLimits): UsageSection | null {
  const sections = usageSections(p)
  if (sections.length === 0) return null
  return sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent) ? candidate : current
  )
}

/** いちばん早く戻る枠までの「Resets in …」 */
export function soonestResetLabel(p: ProviderRateLimits, now: number = Date.now()): string | null {
  const resets = usageSections(p)
    .map((s) => s.window.resetsAt)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
  return resets.length > 0 ? formatResetCountdown(Math.min(...resets) - now) : null
}

/** 取得できなかったときの短い状態（Orca の getProviderUsageStatusLabel の簡略版） */
export function usageStatusLabel(p: ProviderRateLimits): string {
  if (p.status === 'idle' || p.status === 'fetching') return t('usage.status.loading')
  if (p.status === 'unavailable') return t('usage.status.unavailable')
  switch (p.failureKind) {
    case 'missing-credentials':
      return t('usage.status.notLoggedIn')
    case 'stale-token':
      return t('usage.status.staleToken')
    case 'keychain-unavailable':
      return t('usage.status.keychain')
    case 'network':
      return t('usage.status.network')
    case 'rate-limited':
      return t('usage.status.rateLimited')
    default:
      return t('usage.status.failed')
  }
}

/** "plus" → "Plus"、"chatgpt_business" → "ChatGPT Business" */
export function formatPlanLabel(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim()
  if (!trimmed) return null
  return trimmed
    .split(/[\s_-]+/)
    .map((word) => {
      const normalized = word.toLowerCase()
      return normalized === 'chatgpt' ? 'ChatGPT' : normalized.charAt(0).toUpperCase() + normalized.slice(1)
    })
    .join(' ')
}
