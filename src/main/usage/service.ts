import { app, net, type BrowserWindow } from 'electron'
import { accountDisplayName, EMPTY_AGENT_ACCOUNTS } from '@shared/accounts'
import type { AccountUsage, ProviderRateLimits, UsageState } from '@shared/usage'
import type { AccountAgent } from '@shared/types'
import { currentSettings } from '../settings'
import { systemConfigDir, verifyManagedAccountDir } from '../accounts/paths'
import { fetchClaudeUsage, fetchCodexUsage, type UsageRequest } from './fetchers'
import {
  DEFAULT_POLL_MS,
  DEFERRED_STARTUP_REFRESH_MS,
  INACTIVE_FETCH_DEBOUNCE_MS,
  MAX_ACTIVE_FAILURE_STREAK,
  applyStalePolicy,
  isRetryAfterActive,
  providersToRefresh,
  withFetchingStatus
} from './policy'
import { t } from '@shared/i18n'

/**
 * 使用量の取得と保持（フッターの使用量表示の元）。
 *
 * Orca由来: ~/bench/orca/src/main/rate-limits/service.ts,
 *           ~/bench/orca/src/main/rate-limits/service/service-polling.ts,
 *           ~/bench/orca/src/main/rate-limits/service/service-inactive-accounts.ts,
 *           ~/bench/orca/src/main/rate-limits/claude-managed-account-usage.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく
 * - 選択中のアカウント（既定アカウントを含む）の使用量を、窓が見えていて前にあるときだけ15分ごとに取る
 * - 窓が前に出たら、古くなったものと失敗したものだけを取り直す
 * - アカウント別の内訳は、開いたときにだけ取る（60秒以内は取り直さない）
 * - アカウントを切り替えたら、すぐ取り直す
 */

type Target = { key: string; dir: string | undefined }

const request: UsageRequest = (url, init) => net.fetch(url, init)

function userDataDir(): string {
  return app.getPath('userData')
}

function accounts() {
  return currentSettings().agentAccounts ?? EMPTY_AGENT_ACCOUNTS
}

/** アカウントの設定フォルダ。accountId が null ならシステムの既定 */
function targetFor(agent: AccountAgent, accountId: string | null): Target | null {
  if (accountId) {
    const verdict = verifyManagedAccountDir({ userDataDir: userDataDir(), agent, accountId })
    return verdict.kind === 'owned' ? { key: accountId, dir: verdict.dir } : null
  }
  if (agent === 'codex') return { key: 'system', dir: systemConfigDir('codex') }
  // Claude の既定は CLAUDE_CONFIG_DIR を引き継いでいればそれ、無ければ無印の Keychain と ~/.claude
  const inherited = process.env.CLAUDE_CONFIG_DIR?.trim()
  return { key: 'system', dir: inherited || undefined }
}

function activeAccountId(agent: AccountAgent): string | null {
  const list = accounts()[agent]
  return list.accounts.some((a) => a.id === list.activeAccountId) ? list.activeAccountId : null
}

/**
 * 見本データ（ADE_DEMO=1。E2E・撮影用で、通常起動では使わない）。
 * Keychain やネットワークに触れずに、フッターの幅の確認ができるようにする。
 */
function demoUsage(agent: AccountAgent): ProviderRateLimits {
  const now = Date.now()
  const window = (usedPercent: number, windowMinutes: number, inMinutes: number) => ({ usedPercent, windowMinutes, resetsAt: now + inMinutes * 60_000 })
  return agent === 'claude'
    ? { provider: 'claude', session: window(60, 300, 104), weekly: window(18, 10080, 5700), fableWeekly: window(3, 10080, 5700), updatedAt: now, error: null, status: 'ok' }
    : { provider: 'codex', session: null, weekly: window(1, 10080, 10020), planType: 'plus', updatedAt: now, error: null, status: 'ok' }
}

function fetchFor(agent: AccountAgent, target: Target | null): Promise<ProviderRateLimits> {
  if (process.env.ADE_DEMO === '1') return Promise.resolve(demoUsage(agent))
  if (!target) {
    return Promise.resolve({
      provider: agent,
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: t('usage.errors.accountFolderUnusable'),
      status: 'error',
      failureKind: 'missing-credentials'
    })
  }
  return agent === 'claude' ? fetchClaudeUsage(request, target.dir) : fetchCodexUsage(request, target.dir!)
}

const AGENTS: readonly AccountAgent[] = ['claude', 'codex']

let state: UsageState = { claude: null, codex: null }
/** state がどのアカウントの値か。切り替えを見分ける */
const stateKey: Record<AccountAgent, string | null> = { claude: null, codex: null }
const inFlight: Partial<Record<AccountAgent, Promise<void>>> = {}
const lastFailureRetryAt: Record<AccountAgent, number> = { claude: 0, codex: 0 }
const failureStreak: Record<AccountAgent, number> = { claude: 0, codex: 0 }
/** アカウント別の内訳のキャッシュ（agent:accountKey） */
const inactiveCache = new Map<string, ProviderRateLimits>()

let mainWindow: BrowserWindow | null = null
let broadcast: (state: UsageState) => void = () => {}
let timer: NodeJS.Timeout | null = null

function setState(agent: AccountAgent, next: ProviderRateLimits | null): void {
  state = { ...state, [agent]: next }
  broadcast(state)
}

async function fetchProvider(agent: AccountAgent): Promise<void> {
  const running = inFlight[agent]
  if (running) return running
  const work = (async () => {
    const accountId = activeAccountId(agent)
    const target = targetFor(agent, accountId)
    const key = target?.key ?? `broken:${accountId}`
    // 別のアカウントの値を引き継がない
    if (stateKey[agent] !== key) {
      stateKey[agent] = key
      state = { ...state, [agent]: null }
    }
    setState(agent, withFetchingStatus(state[agent], agent))
    const fresh = await fetchFor(agent, target)
    if (stateKey[agent] !== key) return
    if (fresh.status === 'error') {
      failureStreak[agent] = Math.min(failureStreak[agent] + 1, MAX_ACTIVE_FAILURE_STREAK)
      lastFailureRetryAt[agent] = Date.now()
    } else {
      failureStreak[agent] = 0
    }
    const shown = applyStalePolicy(fresh, state[agent])
    setState(agent, shown)
    if (shown.status === 'ok') inactiveCache.set(`${agent}:${key}`, shown)
  })()
  inFlight[agent] = work
  try {
    await work
  } finally {
    inFlight[agent] = undefined
  }
}

function windowActive(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()
}

/** 古くなったもの・失敗したもの・アカウントが替わったものだけを取り直す */
async function refreshStale(): Promise<void> {
  const switched = AGENTS.filter((agent) => stateKey[agent] !== null && stateKey[agent] !== (targetFor(agent, activeAccountId(agent))?.key ?? null))
  const due = providersToRefresh({ state, lastFailureRetryAt, failureStreak })
  await Promise.all([...new Set([...switched, ...due])].map(fetchProvider))
}

export function getUsageState(): UsageState {
  return state
}

/**
 * 再読み込み。force なら5分の連打よけを越えて取りに行く（Retry-After の間は待つ）。
 * force でなければ、古いもの・アカウントが替わったものだけ。
 */
export async function refreshUsage(force: boolean): Promise<UsageState> {
  if (force) await Promise.all(AGENTS.filter((agent) => !isRetryAfterActive(state[agent])).map(fetchProvider))
  else await refreshStale()
  return state
}

/** アカウント別の内訳（既定アカウント＋追加したアカウント）。開いたときだけ呼ぶ */
export async function getAccountUsage(agent: AccountAgent, force = false): Promise<AccountUsage[]> {
  const list = accounts()[agent]
  const active = activeAccountId(agent)
  const rows: Array<{ accountId: string | null; label: string }> = [
    { accountId: null, label: t('accounts.systemDefault') },
    ...list.accounts.filter((a) => a.lastAuthenticatedAt !== null).map((a) => ({ accountId: a.id, label: accountDisplayName(a) }))
  ]
  return Promise.all(
    rows.map(async ({ accountId, label }): Promise<AccountUsage> => {
      const isActive = accountId === active
      const target = targetFor(agent, accountId)
      const cacheKey = `${agent}:${target?.key ?? `broken:${accountId}`}`
      let rateLimits: ProviderRateLimits | null
      if (isActive && state[agent]) rateLimits = state[agent]
      else {
        const cached = inactiveCache.get(cacheKey) ?? null
        if (cached && !force && Date.now() - cached.updatedAt < INACTIVE_FETCH_DEBOUNCE_MS) rateLimits = cached
        else {
          rateLimits = applyStalePolicy(await fetchFor(agent, target), cached)
          if (rateLimits.status === 'ok') inactiveCache.set(cacheKey, rateLimits)
        }
      }
      return { accountId, label, active: isActive, rateLimits }
    })
  )
}

/** 主ウィンドウにつなぐ。定期取得・前に出たときの取り直しを始める */
export function attachUsageWindow(window: BrowserWindow, send: (state: UsageState) => void): void {
  mainWindow = window
  broadcast = send
  const onFocus = (): void => void refreshStale()
  window.on('focus', onFocus)
  window.on('show', onFocus)
  window.on('restore', onFocus)
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    if (windowActive()) void refreshStale()
  }, DEFAULT_POLL_MS)
  timer.unref?.()
  // 起動直後は窓が整ってから1度だけ取りに行く（前にあるかは問わない。最初の表示のため）
  setTimeout(() => void refreshStale(), DEFERRED_STARTUP_REFRESH_MS).unref?.()
}

export function stopUsagePolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}
