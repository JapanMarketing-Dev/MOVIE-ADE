import { describe, expect, it, vi } from 'vitest'
import { shouldShowOnboarding, type OnboardingState } from '@shared/onboarding'
import { OnboardingStore } from '../../src/renderer/onboarding/onboardingStore'
import { completePatch, dismissPatch, reopenPatch, stepPatch } from '../../src/renderer/onboarding/onboardingFlowState'

// settings.ts / settingsFile.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test', isPackaged: false, commandLine: { hasSwitch: () => false } } }))
const { sanitize } = await import('../../src/main/settings')
const { mergeSettings, splitSettings } = await import('../../src/main/settingsFile')

const NOW = '2026-10-03T00:00:00.000Z'

/** 画面の状態（App の setOnboarding）を写し取る */
function harness(save: (patch: unknown) => Promise<unknown>, initial: OnboardingState | null = null) {
  const seen: Array<OnboardingState | null> = []
  const onError = vi.fn()
  const store = new OnboardingStore(initial, { save, onChange: (s) => seen.push(s), onError })
  const open = () => shouldShowOnboarding(store.current ?? undefined)
  return { store, seen, onError, open }
}

describe('OnboardingStore（「始める」が保存の成否に関わらず閉じる）', () => {
  it('保存が失敗しても、押した時点で閉じ、失敗は onError で知らせる', async () => {
    const h = harness(() => Promise.reject(new Error('No handler registered for settings:onboarding')), { lastStep: 'finish' })
    expect(h.open()).toBe(true)
    const done = h.store.apply(completePatch(NOW))
    // 保存を待たずに閉じている
    expect(h.open()).toBe(false)
    await done
    expect(h.onError).toHaveBeenCalledTimes(1)
    expect(h.open()).toBe(false)
  })

  it('保存の戻り値に completedAt が無くても（main が落とした）、閉じたまま', async () => {
    const h = harness(async () => ({ lastStep: 'finish' }), { lastStep: 'finish' })
    await h.store.apply(completePatch(NOW))
    expect(h.open()).toBe(false)
    expect(h.store.current).toEqual({ completedAt: NOW })
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('閉じるの直前に送った手順の保存が後から返っても、開き直さない', async () => {
    let releaseFirst: () => void = () => undefined
    const save = vi.fn((patch: unknown) => (patch as { lastStep?: string }).lastStep === 'finish'
      ? new Promise<unknown>((resolve) => { releaseFirst = () => resolve({ lastStep: 'finish' }) })
      : Promise.resolve(null))
    const h = harness(save)
    const first = h.store.apply(stepPatch(5))
    const second = h.store.apply(completePatch(NOW))
    expect(h.open()).toBe(false)
    // 1件目の保存が始まるのを待ってから返す
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    releaseFirst()
    await Promise.all([first, second])
    expect(h.open()).toBe(false)
    // 保存は送った順に行う
    expect(save.mock.calls.map(([p]) => p)).toEqual([stepPatch(5), completePatch(NOW)])
  })

  it('もう一度セットアップ → 始める を2回続けても、そのたびに開いて閉じる', async () => {
    const h = harness(async () => null, { completedAt: NOW })
    for (let i = 0; i < 2; i++) {
      await h.store.apply(reopenPatch())
      expect(h.open()).toBe(true)
      await h.store.apply(stepPatch(5))
      expect(h.open()).toBe(true)
      await h.store.apply(completePatch(NOW))
      expect(h.open()).toBe(false)
    }
  })

  it('閉じる（スキップ）も同じくすぐ閉じる', () => {
    const h = harness(() => Promise.reject(new Error('x')))
    void h.store.apply(dismissPatch(NOW))
    expect(h.open()).toBe(false)
  })

  it('失敗した後の保存も続けて行う（キューが止まらない）', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValue(null)
    const h = harness(save)
    await h.store.apply(stepPatch(1))
    await h.store.apply(completePatch(NOW))
    expect(save).toHaveBeenCalledTimes(2)
    expect(h.onError).toHaveBeenCalledTimes(1)
  })
})

describe('settings.json と state.json の分割で onboarding が残る', () => {
  it('分けて戻しても completedAt / dismissedAt / lastStep が消えない', () => {
    for (const onboarding of [{ completedAt: NOW }, { dismissedAt: NOW }, { lastStep: 'voice' as const }]) {
      const settings = sanitize({ projects: [], onboarding })
      const { config, state } = splitSettings(settings)
      expect(config.onboarding).toEqual(onboarding)
      expect(sanitize(mergeSettings(config, state)).onboarding).toEqual(onboarding)
    }
  })

  it('onboarding は設定（settings.json）側で、state.json には入らない', () => {
    const { state } = splitSettings(sanitize({ onboarding: { completedAt: NOW } }))
    expect('onboarding' in state).toBe(false)
  })
})
