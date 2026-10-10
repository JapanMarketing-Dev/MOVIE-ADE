/**
 * 上限の手前で引き継ぐ（src/main/failover/plan.ts の nearLimitTabs・src/shared/failover.ts の handoffPercent）。
 * 動いているタブのアカウントが handoffPercent 以上なら、上限の知らせを待たずに次の優先順位で開き直す（夜間も止めない）
 */
import { describe, expect, it } from 'vitest'
import { nearLimitTabs, type RunningTab } from '../../src/main/failover/plan'
import { DEFAULT_LIMIT_FAILOVER, sanitizeLimitFailover } from '../../src/shared/failover'

const tab = (id: string, cwd: string, agent: 'claude' | 'codex', accountId: string | null): RunningTab => ({ id, cwd, agent, accountId })
const usage: Record<string, number | null> = { 'claude:a': 98, 'claude:b': 40, 'claude:null': 99.5, 'codex:null': 97.9, 'codex:x': null }
const used = (agent: string, accountId: string | null) => usage[`${agent}:${accountId}`] ?? null

describe('上限の手前で引き継ぐタブ', () => {
  it('使っているアカウントが handoffPercent 以上のタブだけ（ちょうどの値を含む）', () => {
    const tabs = [tab('1', '/p1', 'claude', 'a'), tab('2', '/p2', 'claude', 'b'), tab('3', '/p3', 'claude', null), tab('4', '/p4', 'codex', null)]
    expect(nearLimitTabs(tabs, used, 98, new Set(), new Set()).map((t) => t.id)).toEqual(['1', '3'])
    expect(nearLimitTabs(tabs, used, 97, new Set(), new Set()).map((t) => t.id)).toEqual(['1', '3', '4'])
  })

  it('使用量が分からないアカウントは引き継がない', () => {
    expect(nearLimitTabs([tab('1', '/p', 'codex', 'x'), tab('2', '/q', 'claude', 'unknown')], used, 50, new Set(), new Set())).toEqual([])
  })

  it('始めたタブ・切り替え中のフォルダは除き、同じフォルダは1つずつ', () => {
    const tabs = [tab('1', '/p', 'claude', 'a'), tab('2', '/p', 'claude', null), tab('3', '/q', 'claude', 'a'), tab('4', '/r', 'claude', 'a')]
    expect(nearLimitTabs(tabs, used, 98, new Set(['3']), new Set(['/r'])).map((t) => t.id)).toEqual(['1'])
  })

  it('100 以上なら手前では引き継がない', () => {
    expect(nearLimitTabs([tab('1', '/p', 'claude', null)], () => 100, 100, new Set(), new Set())).toEqual([])
  })
})

describe('handoffPercent の設定', () => {
  it('既定は 98。50〜100 に収め、整数にする。数でなければ既定', () => {
    expect(DEFAULT_LIMIT_FAILOVER.handoffPercent).toBe(98)
    expect(sanitizeLimitFailover({}).handoffPercent).toBe(98)
    expect(sanitizeLimitFailover({ handoffPercent: 10 }).handoffPercent).toBe(50)
    expect(sanitizeLimitFailover({ handoffPercent: 150 }).handoffPercent).toBe(100)
    expect(sanitizeLimitFailover({ handoffPercent: 96.6 }).handoffPercent).toBe(97)
    for (const bad of ['98', null, Number.NaN, Number.POSITIVE_INFINITY]) expect(sanitizeLimitFailover({ handoffPercent: bad }).handoffPercent).toBe(98)
  })
})
