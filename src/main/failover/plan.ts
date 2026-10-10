import type { LimitFailoverPrefs } from '@shared/failover'
import type { AccountAgent, TuiAgent } from '@shared/types'

/**
 * 切り替え先の選び方と、切り替えの回数・間隔の上限（副作用のない部分）。
 *
 * 選ぶ順:
 * 1. 同じ Agent の別のアカウント（switchAccounts が入のとき。Claude Code / Codex だけ）。
 *    上限とみなしたもの・しきい値以上のものは除き、Claude in Chrome とつながるアカウント（chrome）を先に、
 *    そのあと使用量の低い順。使用量が分からないものは最後
 * 2. 優先順位（agentOrder）の先頭から、今の Agent 以外で使えるもの。
 *    Claude Code / Codex は、そのうち使えるアカウント（switchAccounts が切なら選択中のアカウントだけ）
 * どれも無ければ null（枠が戻るのを待つ）。
 */

/** アカウントの1件。accountId が null ならシステムの既定アカウント */
export interface AccountCandidate {
  accountId: string | null
  /** ログイン済み */
  signedIn: boolean
  /** 使用量のいちばん高い枠（%）。分からなければ null */
  usedPercent: number | null
  /** 選択中 */
  active: boolean
  /**
   * Claude in Chrome とつながるアカウント（拡張機能と同じ claude.ai のアカウント。accounts/chromePairing.ts）。
   * 拡張機能は別のアカウントの Claude Code とはつながらないので、使えるならこれを先に選ぶ
   */
  chrome?: boolean
}

export interface FailoverTarget {
  agent: TuiAgent
  /** Claude Code / Codex のときだけ。null はシステムの既定アカウント。undefined はアカウントを持たない Agent */
  accountId?: string | null
}

export interface PlanInput {
  prefs: LimitFailoverPrefs
  /** 上限になった Agent とアカウント */
  from: FailoverTarget
  /** Claude Code / Codex のアカウント（ログイン待ちのものは含めない） */
  accounts: Record<AccountAgent, AccountCandidate[]>
  /** インストール済みで、無効にしていない Agent */
  available: ReadonlySet<TuiAgent>
  /** 上限とみなしている間（limitKey → この時刻まで）。ターミナルの知らせや使用量から */
  limited: ReadonlyMap<string, number>
  now: number
}

export function isAccountAgentId(agent: TuiAgent): agent is AccountAgent {
  return agent === 'claude' || agent === 'codex'
}

/** 上限を覚えておくときの鍵 */
export function limitKey(target: FailoverTarget): string {
  return isAccountAgentId(target.agent) ? `${target.agent}:${target.accountId ?? 'system'}` : target.agent
}

function isLimited(input: Pick<PlanInput, 'limited' | 'now'>, target: FailoverTarget): boolean {
  const until = input.limited.get(limitKey(target))
  return until !== undefined && until > input.now
}

/** その Agent の使えるアカウントを、使用量の低い順に（分からないものは最後。同じなら選択中を先に） */
export function usableAccounts(input: PlanInput, agent: AccountAgent, exclude: string | null | undefined = undefined): AccountCandidate[] {
  const threshold = input.prefs.thresholdPercent
  return input.accounts[agent]
    .filter((a) => a.signedIn && (exclude === undefined || a.accountId !== exclude))
    .filter((a) => !isLimited(input, { agent, accountId: a.accountId }))
    .filter((a) => a.usedPercent === null || a.usedPercent < threshold)
    .sort((a, b) => {
      if (Boolean(a.chrome) !== Boolean(b.chrome)) return a.chrome ? -1 : 1
      if (a.usedPercent === null && b.usedPercent !== null) return 1
      if (b.usedPercent === null && a.usedPercent !== null) return -1
      const diff = (a.usedPercent ?? 0) - (b.usedPercent ?? 0)
      return diff !== 0 ? diff : Number(b.active) - Number(a.active)
    })
}

/** 別の Agent へ引き継ぐときの、その Agent の使える先（無ければ null） */
function agentTarget(input: PlanInput, agent: TuiAgent): FailoverTarget | null {
  if (!input.available.has(agent)) return null
  if (!isAccountAgentId(agent)) return isLimited(input, { agent }) ? null : { agent }
  const usable = usableAccounts(input, agent)
  if (input.prefs.switchAccounts) return usable[0] ? { agent, accountId: usable[0].accountId } : null
  // アカウントを切り替えないときは、選択中のアカウントだけを使う
  const active = usable.find((a) => a.active)
  return active ? { agent, accountId: active.accountId } : null
}

export function planFailover(input: PlanInput): FailoverTarget | null {
  const { from, prefs } = input
  if (prefs.switchAccounts && isAccountAgentId(from.agent)) {
    const next = usableAccounts(input, from.agent, from.accountId ?? null)[0]
    if (next) return { agent: from.agent, accountId: next.accountId }
  }
  for (const agent of prefs.agentOrder) {
    if (agent === from.agent) continue
    const target = agentTarget(input, agent)
    if (target) return target
  }
  return null
}

/**
 * 優先順位の高い Agent へ戻すか（returnToPreferred）。今の Agent より前に並ぶ Agent で使えるものがあればそれ。
 * 今の Agent が優先順位に無ければ、先頭から使えるもの
 */
export function planReturn(input: Omit<PlanInput, 'from'> & { current: TuiAgent }): FailoverTarget | null {
  const rank = input.prefs.agentOrder.indexOf(input.current)
  const ahead = rank < 0 ? input.prefs.agentOrder : input.prefs.agentOrder.slice(0, rank)
  for (const agent of ahead) {
    const target = agentTarget({ ...input, from: { agent: input.current } }, agent)
    if (target) return target
  }
  return null
}

/**
 * Claude in Chrome とつながるアカウントへ戻す先。今のアカウント（current）が Chrome とつながらず、
 * つながるアカウントに余裕があればそれ。どれもつないでいない・今のアカウントがつながる・余裕が無ければ null
 */
export function chromeReturnTarget(input: Omit<PlanInput, 'from'>, agent: AccountAgent, current: string | null): AccountCandidate | null {
  const candidates = input.accounts[agent]
  if (!candidates.some((a) => a.chrome)) return null
  if (candidates.some((a) => a.chrome && a.accountId === current)) return null
  const usable = usableAccounts({ ...input, from: { agent, accountId: current } }, agent, current)
  return usable.find((a) => a.chrome) ?? null
}

// ───────────────────────── 回数と間隔の上限 ─────────────────────────

/** 1時間に切り替えてよい回数（プロジェクトごと） */
export const MAX_SWITCHES_PER_HOUR = 6
/** 続けて切り替えるときの最短の間隔 */
export const MIN_SWITCH_INTERVAL_MS = 60_000
const HOUR_MS = 60 * 60 * 1000

/** 切り替えてよいか。だめなら、いつからよいか */
export function switchAllowed(history: readonly number[], now: number): { ok: true } | { ok: false; retryAt: number } {
  const recent = history.filter((at) => now - at < HOUR_MS).sort((a, b) => a - b)
  const last = recent[recent.length - 1]
  if (last !== undefined && now - last < MIN_SWITCH_INTERVAL_MS) return { ok: false, retryAt: last + MIN_SWITCH_INTERVAL_MS }
  if (recent.length >= MAX_SWITCHES_PER_HOUR) return { ok: false, retryAt: recent[recent.length - MAX_SWITCHES_PER_HOUR]! + HOUR_MS }
  return { ok: true }
}

/** 上限とみなす間。使用量から戻る時刻が分かればそこまで、分からなければ1時間 */
export const DEFAULT_LIMIT_COOLDOWN_MS = HOUR_MS

/**
 * 利用者がアカウントを選び直したときに開き直すタブ。その Agent のタブで、起動したアカウントが選んだものと違うもの。
 * 起動したアカウントが分からない（undefined）タブはシステムの既定で開いたものとみなす
 */
export function tabsToSwitch<T extends { id: string; agent: TuiAgent | null; launchedAccount: string | null | undefined }>(
  tabs: readonly T[], agent: AccountAgent, accountId: string | null
): T[] {
  return tabs.filter((tab) => tab.agent === agent && (tab.launchedAccount ?? null) !== accountId)
}
