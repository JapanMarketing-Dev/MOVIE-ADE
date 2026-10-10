import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LIMIT_FAILOVER } from '../../src/shared/failover'
import { chromeReturnTarget, limitKey, planFailover, usableAccounts, type AccountCandidate, type PlanInput } from '../../src/main/failover/plan'
import { hasChromePairing, managedClaudeChromePaired, systemClaudeChromePaired } from '../../src/main/accounts/chromePairing'

/**
 * Claude in Chrome は拡張機能と同じ claude.ai のアカウントの Claude Code としかつながらない。
 * 上限での切り替えが Chrome とつながるアカウントを先に選び、枠が戻ればそちらへ戻すこと。
 * 本物の CLI・アカウント・Chrome は使わない。
 */

function input(claude: AccountCandidate[], overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    prefs: { ...DEFAULT_LIMIT_FAILOVER },
    from: { agent: 'claude', accountId: null },
    accounts: { claude, codex: [{ accountId: null, signedIn: true, usedPercent: 5, active: true }] },
    available: new Set(['claude', 'codex']),
    limited: new Map(),
    now: 1_000_000,
    ...overrides
  }
}

describe('Claude in Chrome とつないだ印', () => {
  it('chromeExtension.pairedDeviceId があればつないだとみなす', () => {
    expect(hasChromePairing(JSON.stringify({ chromeExtension: { pairedDeviceId: 'dev-1', pairedDeviceName: 'Browser 1' } }))).toBe(true)
    expect(hasChromePairing('{\n  "a": 1,\n  "chromeExtension": {\n    "pairedDeviceId": "x"\n  }\n}')).toBe(true)
  })

  it('印が無い・空・形が違う・壊れているならつないでいない', () => {
    expect(hasChromePairing(JSON.stringify({ claudeInChromeDefaultEnabled: true }))).toBe(false)
    expect(hasChromePairing(JSON.stringify({ chromeExtension: { pairedDeviceId: '' } }))).toBe(false)
    expect(hasChromePairing(JSON.stringify({ chromeExtension: { pairedDeviceId: 3 } }))).toBe(false)
    expect(hasChromePairing(JSON.stringify({ chromeExtension: [] }))).toBe(false)
    expect(hasChromePairing('{"chromeExtension": {"pairedDeviceId": "x"')).toBe(false)
    expect(hasChromePairing('')).toBe(false)
  })
})

describe('設定フォルダから読む', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chrome-pairing-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('管理アカウントは CLAUDE_CONFIG_DIR の .claude.json を見る', async () => {
    const dir = join(root, 'acct')
    mkdirSync(dir)
    expect(await managedClaudeChromePaired(dir)).toBe(false)
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {}, chromeExtension: { pairedDeviceId: 'd' } }))
    expect(await managedClaudeChromePaired(dir)).toBe(true)
  })

  it('システムの既定は ~/.claude.json（CLAUDE_CONFIG_DIR を引き継いでいればその中）', async () => {
    const home = join(root, 'home')
    mkdirSync(home)
    expect(await systemClaudeChromePaired({}, home)).toBe(false)
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ chromeExtension: { pairedDeviceId: 'd' } }))
    expect(await systemClaudeChromePaired({}, home)).toBe(true)
    const inherited = join(root, 'inherited')
    mkdirSync(inherited)
    expect(await systemClaudeChromePaired({ CLAUDE_CONFIG_DIR: inherited }, home)).toBe(false)
  })
})

describe('Chrome とつながるアカウントを先に選ぶ', () => {
  it('上限で切り替えるとき、使用量が多くても Chrome とつながるアカウントを先に選ぶ', () => {
    const plan = input([
      { accountId: 'work', signedIn: true, usedPercent: 100, active: true },
      { accountId: 'spare', signedIn: true, usedPercent: 5, active: false },
      { accountId: null, signedIn: true, usedPercent: 60, active: false, chrome: true }
    ], { from: { agent: 'claude', accountId: 'work' } })
    expect(planFailover(plan)).toEqual({ agent: 'claude', accountId: null })
  })

  it('Chrome とつながるアカウントがしきい値以上・上限なら、ほかのアカウントへ', () => {
    const claude: AccountCandidate[] = [
      { accountId: 'work', signedIn: true, usedPercent: 100, active: true },
      { accountId: 'spare', signedIn: true, usedPercent: 5, active: false },
      { accountId: null, signedIn: true, usedPercent: 96, active: false, chrome: true }
    ]
    expect(planFailover(input(claude, { from: { agent: 'claude', accountId: 'work' } }))).toEqual({ agent: 'claude', accountId: 'spare' })
    const cooled = claude.map((c) => (c.accountId === null ? { ...c, usedPercent: 10 } : c))
    const limited = new Map([[limitKey({ agent: 'claude', accountId: null }), 2_000_000]])
    expect(planFailover(input(cooled, { from: { agent: 'claude', accountId: 'work' }, limited }))).toEqual({ agent: 'claude', accountId: 'spare' })
  })

  it('どれも Chrome とつないでいなければ、今までどおり使用量の低い順', () => {
    const plan = input([
      { accountId: null, signedIn: true, usedPercent: 100, active: true },
      { accountId: 'a', signedIn: true, usedPercent: 40, active: false },
      { accountId: 'b', signedIn: true, usedPercent: 10, active: false }
    ])
    expect(usableAccounts(plan, 'claude', null).map((a) => a.accountId)).toEqual(['b', 'a'])
  })
})

describe('Chrome とつながるアカウントへ戻す', () => {
  const base: AccountCandidate[] = [
    { accountId: null, signedIn: true, usedPercent: 30, active: false, chrome: true },
    { accountId: 'spare', signedIn: true, usedPercent: 50, active: true }
  ]

  it('今のアカウントが Chrome とつながらず、つながるアカウントに余裕があれば戻す', () => {
    expect(chromeReturnTarget(input(base), 'claude', 'spare')?.accountId).toBeNull()
  })

  it('今のアカウントが Chrome とつながるなら戻さない', () => {
    expect(chromeReturnTarget(input(base), 'claude', null)).toBeNull()
  })

  it('つながるアカウントがまだしきい値以上・上限・ログアウトなら戻さない', () => {
    const over = base.map((c) => (c.chrome ? { ...c, usedPercent: 97 } : c))
    expect(chromeReturnTarget(input(over), 'claude', 'spare')).toBeNull()
    const limited = new Map([[limitKey({ agent: 'claude', accountId: null }), 2_000_000]])
    expect(chromeReturnTarget(input(base, { limited }), 'claude', 'spare')).toBeNull()
    const signedOut = base.map((c) => (c.chrome ? { ...c, signedIn: false } : c))
    expect(chromeReturnTarget(input(signedOut), 'claude', 'spare')).toBeNull()
  })

  it('どれも Chrome とつないでいなければ戻さない', () => {
    const none = base.map((c) => ({ ...c, chrome: false }))
    expect(chromeReturnTarget(input(none), 'claude', 'spare')).toBeNull()
  })
})
