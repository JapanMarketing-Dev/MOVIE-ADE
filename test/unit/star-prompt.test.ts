import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STAR_PROMPT,
  STAR_PROMPT_COOLDOWN_MS,
  STAR_PROMPT_MAX_SHOWS,
  blockedReason,
  countEvent,
  isMoment,
  sanitizeStarPrompt,
  type StarPromptState
} from '@shared/starPrompt'
import { StarPromptService, type StarPromptDeps } from '../../src/main/starPrompt'
import { checkStarred, starRepo } from '../../src/main/github/star'
import type { ExecResult } from '../../src/main/github/gh'

const NOW = 10_000_000_000
const ok: Omit<Parameters<typeof blockedReason>[1], 'now'> = { recording: false, onboardingDone: true }

function harness(initial: Partial<StarPromptState> = {}, overrides: Partial<StarPromptDeps> = {}) {
  let state: StarPromptState = { ...DEFAULT_STAR_PROMPT, ...initial }
  let ctx = { ...ok }
  const deps = {
    getState: () => state,
    setState: vi.fn((next: StarPromptState) => { state = next }),
    context: () => ctx,
    now: () => NOW,
    checkStarred: vi.fn(async () => false as boolean | null),
    starRepo: vi.fn(async () => true),
    openRepo: vi.fn(async () => {}),
    show: vi.fn(() => true),
    ...overrides
  }
  return { service: new StarPromptService(deps), deps, state: () => state, setContext: (c: Partial<typeof ctx>) => { ctx = { ...ctx, ...c } } }
}

describe('star のお願い: 場面と条件', () => {
  it('最初の送信と、レビューが 3・10・30 件になったときだけが場面', () => {
    expect(isMoment(countEvent(DEFAULT_STAR_PROMPT, 'first-send'), 'first-send')).toBe(true)
    expect(isMoment(countEvent({ ...DEFAULT_STAR_PROMPT, sends: 1 }, 'first-send'), 'first-send')).toBe(false)
    const reviews = [1, 2, 3, 4, 10, 11, 30].map((n) => isMoment({ ...DEFAULT_STAR_PROMPT, reviews: n }, 'reviews'))
    expect(reviews).toEqual([false, false, true, false, true, false, true])
  })

  it('done・上限・クールダウン・録画中・セットアップ中は出さない', () => {
    const base = { ...DEFAULT_STAR_PROMPT }
    expect(blockedReason(base, { ...ok, now: NOW })).toBeNull()
    expect(blockedReason({ ...base, done: true }, { ...ok, now: NOW })).toBe('done')
    expect(blockedReason({ ...base, count: STAR_PROMPT_MAX_SHOWS }, { ...ok, now: NOW })).toBe('cap')
    expect(blockedReason({ ...base, lastShownAt: NOW - STAR_PROMPT_COOLDOWN_MS + 1 }, { ...ok, now: NOW })).toBe('cooldown')
    expect(blockedReason({ ...base, lastShownAt: NOW - STAR_PROMPT_COOLDOWN_MS }, { ...ok, now: NOW })).toBeNull()
    expect(blockedReason(base, { now: NOW, recording: true, onboardingDone: true })).toBe('recording')
    expect(blockedReason(base, { now: NOW, recording: false, onboardingDone: false })).toBe('onboarding')
  })

  it('保存された値の読み直し。壊れた値は既定へ', () => {
    expect(sanitizeStarPrompt(null)).toBeUndefined()
    expect(sanitizeStarPrompt({ done: 'yes', count: -1, lastShownAt: 'x', sends: 2.5, reviews: 4 }))
      .toEqual({ done: false, count: 0, lastShownAt: null, sends: 0, reviews: 4 })
  })
})

describe('star のお願い: サービス', () => {
  it('最初の送信で gh モードのトーストを出し、回数と時刻を残す', async () => {
    const h = harness()
    expect(await h.service.record('first-send')).toBe(true)
    expect(h.deps.show).toHaveBeenCalledWith('gh')
    expect(h.state()).toMatchObject({ sends: 1, count: 1, lastShownAt: NOW, done: false })
  })

  it('gh で分からなければブラウザで開く案内にする', async () => {
    const h = harness({}, { checkStarred: vi.fn(async () => null) })
    await h.service.record('first-send')
    expect(h.deps.show).toHaveBeenCalledWith('web')
  })

  it('すでに star 済みなら出さず、二度と聞かない', async () => {
    const h = harness({}, { checkStarred: vi.fn(async () => true) })
    expect(await h.service.record('first-send')).toBe(false)
    expect(h.deps.show).not.toHaveBeenCalled()
    expect(h.state().done).toBe(true)
  })

  it('録画中・セットアップ中は数えるだけで、gh も呼ばない', async () => {
    const h = harness({ reviews: 2 })
    h.setContext({ recording: true })
    expect(await h.service.record('reviews')).toBe(false)
    h.setContext({ recording: false, onboardingDone: false })
    expect(await h.service.record('first-send')).toBe(false)
    expect(h.deps.checkStarred).not.toHaveBeenCalled()
    expect(h.state()).toMatchObject({ reviews: 3, sends: 1, count: 0 })
  })

  it('gh を調べている間に録画が始まったら出さない', async () => {
    let release: (v: boolean) => void = () => {}
    const h = harness({}, { checkStarred: vi.fn(() => new Promise<boolean | null>((r) => { release = r })) })
    const pending = h.service.record('first-send')
    h.setContext({ recording: true })
    release(false)
    expect(await pending).toBe(false)
    expect(h.deps.show).not.toHaveBeenCalled()
  })

  it('クールダウン中・上限・done の後は出さない', async () => {
    expect(await harness({ reviews: 2, lastShownAt: NOW - 1000, count: 1 }).service.record('reviews')).toBe(false)
    expect(await harness({ reviews: 2, count: STAR_PROMPT_MAX_SHOWS }).service.record('reviews')).toBe(false)
    expect(await harness({ reviews: 2, done: true }).service.record('reviews')).toBe(false)
  })

  it('Star で star できたら done。できなければ done にしない', async () => {
    const h = harness()
    expect(await h.service.star()).toBe(true)
    expect(h.state().done).toBe(true)
    const failed = harness({}, { starRepo: vi.fn(async () => false) })
    expect(await failed.service.star()).toBe(false)
    expect(failed.state().done).toBe(false)
  })

  it('「今後表示しない」で done。ブラウザで開くだけなら done にしない', async () => {
    const h = harness()
    h.service.never()
    expect(h.state().done).toBe(true)
    const web = harness()
    await web.service.openWeb()
    expect(web.deps.openRepo).toHaveBeenCalled()
    expect(web.state().done).toBe(false)
  })

  it('メニューの入口: gh で star、gh が使えない・失敗ならブラウザで開く', async () => {
    const viaGh = harness()
    expect(await viaGh.service.starFromMenu()).toBe('starred')
    expect(viaGh.deps.starRepo).toHaveBeenCalledTimes(1)

    const noGh = harness({}, { checkStarred: vi.fn(async () => null) })
    expect(await noGh.service.starFromMenu()).toBe('opened')
    expect(noGh.deps.starRepo).not.toHaveBeenCalled()
    expect(noGh.deps.openRepo).toHaveBeenCalled()

    const failed = harness({}, { starRepo: vi.fn(async () => false) })
    expect(await failed.service.starFromMenu()).toBe('opened')

    const already = harness({}, { checkStarred: vi.fn(async () => true) })
    expect(await already.service.starFromMenu()).toBe('starred')
    expect(already.deps.starRepo).not.toHaveBeenCalled()
  })
})

describe('フィードバックの声かけ（送信 3 回で一度だけ）', () => {
  it('3 回目の送信で一度だけ出し、出した時点で記録する。4 回目以降は出さない', async () => {
    const askFeedback = vi.fn(() => true)
    const h = harness({ sends: 2, done: true }, { askFeedback })
    await h.service.record('first-send')
    expect(askFeedback).toHaveBeenCalledTimes(1)
    expect(h.state()).toMatchObject({ sends: 3, feedbackAsked: true })
    await h.service.record('first-send')
    expect(askFeedback).toHaveBeenCalledTimes(1)
  })

  it('録画中は出さず、次の送信まで待つ', async () => {
    const askFeedback = vi.fn(() => true)
    const h = harness({ sends: 2, done: true }, { askFeedback })
    h.setContext({ recording: true })
    await h.service.record('first-send')
    expect(askFeedback).not.toHaveBeenCalled()
    h.setContext({ recording: false })
    await h.service.record('first-send')
    expect(askFeedback).toHaveBeenCalledTimes(1)
  })
})

describe('star のお願い: gh の呼び方（gh はモック）', () => {
  const result = (patch: Partial<ExecResult>): ExecResult => ({ stdout: '', stderr: '', failed: false, missing: false, timedOut: false, ...patch })

  it('204 は star 済み、404 はまだ、それ以外は分からない', async () => {
    const run = vi.fn(async () => result({ stdout: 'HTTP/2.0 204 No Content\r\n' }))
    expect(await checkStarred(run)).toBe(true)
    expect(run).toHaveBeenCalledWith(['api', '--include', 'user/starred/JapanMarketing-Dev/ferret'], expect.anything())
    expect(await checkStarred(async () => result({ failed: true, stdout: 'HTTP/2.0 404 Not Found', stderr: 'gh: Not Found (HTTP 404)' }))).toBe(false)
    expect(await checkStarred(async () => result({ failed: true, missing: true }))).toBeNull()
    expect(await checkStarred(async () => result({ failed: true, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }))).toBeNull()
  })

  it('同時に聞かれても gh は1回だけ', async () => {
    const run = vi.fn(async () => result({ stdout: 'HTTP/2.0 204 No Content' }))
    await Promise.all([checkStarred(run), checkStarred(run)])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('star は PUT。失敗なら false', async () => {
    const run = vi.fn(async () => result({}))
    expect(await starRepo(run)).toBe(true)
    expect(run).toHaveBeenCalledWith(['api', '-X', 'PUT', 'user/starred/JapanMarketing-Dev/ferret'], expect.anything())
    expect(await starRepo(async () => result({ failed: true }))).toBe(false)
  })
})
