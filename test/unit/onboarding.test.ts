import { describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_STEPS,
  applyOnboardingPatch,
  migrateOnboarding,
  sanitizeOnboarding,
  shouldShowOnboarding,
  type OnboardingState
} from '@shared/onboarding'
import {
  LAST_STEP_INDEX,
  clampStepIndex,
  completePatch,
  dismissPatch,
  initialStepIndex,
  isContinueShortcut,
  isSkippableStep,
  nextStepIndex,
  previousStepIndex,
  reopenPatch,
  stepIdAt,
  stepPatch,
  voiceModeOf
} from '../../src/renderer/onboarding/onboardingFlowState'

// settings.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))
const { sanitize } = await import('../../src/main/settings')

const NOW = '2026-10-03T00:00:00.000Z'

describe('shouldShowOnboarding', () => {
  it('未設定・途中（lastStep だけ）なら出す', () => {
    expect(shouldShowOnboarding(undefined)).toBe(true)
    expect(shouldShowOnboarding({})).toBe(true)
    expect(shouldShowOnboarding({ lastStep: 'voice' })).toBe(true)
  })

  it('完了・途中で閉じたなら出さない', () => {
    expect(shouldShowOnboarding({ completedAt: NOW })).toBe(false)
    expect(shouldShowOnboarding({ dismissedAt: NOW, lastStep: 'agents' })).toBe(false)
  })
})

describe('sanitizeOnboarding', () => {
  it('知っている項目だけを残す', () => {
    expect(sanitizeOnboarding({ completedAt: NOW, lastStep: 'project', extra: 1 })).toEqual({ completedAt: NOW, lastStep: 'project' })
  })

  it('壊れた値は捨て、空なら undefined（settings.json に書かない）', () => {
    expect(sanitizeOnboarding({ completedAt: 1, dismissedAt: '', lastStep: 'nope' })).toBeUndefined()
    expect(sanitizeOnboarding(null)).toBeUndefined()
    expect(sanitizeOnboarding('x')).toBeUndefined()
    expect(sanitizeOnboarding({ completedAt: 'x'.repeat(65) })).toBeUndefined()
  })
})

describe('applyOnboardingPatch', () => {
  it('null は消し、undefined は前の値のまま', () => {
    expect(applyOnboardingPatch({ completedAt: NOW, lastStep: 'voice' }, { completedAt: null, lastStep: undefined })).toEqual({ lastStep: 'voice' })
  })

  it('開き直す（reopenPatch）と全部消えて、また出る', () => {
    const next = applyOnboardingPatch({ completedAt: NOW, dismissedAt: NOW, lastStep: 'finish' }, reopenPatch())
    expect(next).toBeUndefined()
    expect(shouldShowOnboarding(next)).toBe(true)
  })

  it('知らない項目・壊れた手順は書かない', () => {
    expect(applyOnboardingPatch(undefined, { lastStep: 'bogus' as never, ...({ other: 'x' } as object) })).toBeUndefined()
  })
})

describe('migrateOnboarding（オンボーディングを足す前からの利用者）', () => {
  const now = () => NOW
  const settings = (projects: unknown[]): { projects: unknown[]; onboarding?: OnboardingState } => ({ projects })

  it('プロジェクトを登録済みなら済んだ扱いにする', () => {
    expect(migrateOnboarding(settings([{ id: 'p' }]), { now }).onboarding).toEqual({ completedAt: NOW })
  })

  it('プロジェクトが無ければ出す（初回起動）', () => {
    expect(migrateOnboarding(settings([]), { now }).onboarding).toBeUndefined()
  })

  it('途中の人（onboarding がある）はそのまま再開する', () => {
    const midway = { projects: [{ id: 'p' }], onboarding: { lastStep: 'voice' as const } }
    expect(migrateOnboarding(midway, { now })).toBe(midway)
  })

  it('skip（E2E）なら初回でも出さない', () => {
    expect(migrateOnboarding(settings([]), { skip: true, now }).onboarding).toEqual({ completedAt: NOW })
  })
})

describe('sanitize（settings.json）の onboarding', () => {
  it('正しい値は残り、壊れた値は落ちる', () => {
    expect(sanitize({ onboarding: { dismissedAt: NOW, lastStep: 'agents' } }).onboarding).toEqual({ dismissedAt: NOW, lastStep: 'agents' })
    expect('onboarding' in sanitize({ onboarding: { lastStep: 3 } })).toBe(false)
    expect('onboarding' in sanitize({})).toBe(false)
  })

  it('updateSettings と同じく、undefined を重ねると消える', () => {
    const before = sanitize({ onboarding: { completedAt: NOW } })
    expect('onboarding' in sanitize({ ...before, onboarding: undefined })).toBe(false)
  })
})

describe('手順の進め方', () => {
  it('手順は6つで、最後は finish', () => {
    expect(ONBOARDING_STEPS).toEqual(['appearance', 'agents', 'project', 'voice', 'permissions', 'finish'])
    expect(stepIdAt(LAST_STEP_INDEX)).toBe('finish')
  })

  it('次へ・戻るは範囲に収まり、最後の次は null（完了）', () => {
    expect(nextStepIndex(0)).toBe(1)
    expect(nextStepIndex(LAST_STEP_INDEX - 1)).toBe(LAST_STEP_INDEX)
    expect(nextStepIndex(LAST_STEP_INDEX)).toBeNull()
    expect(previousStepIndex(0)).toBe(0)
    expect(previousStepIndex(3)).toBe(2)
    expect(clampStepIndex(99)).toBe(LAST_STEP_INDEX)
    expect(clampStepIndex(-4)).toBe(0)
    expect(clampStepIndex(Number.NaN)).toBe(0)
  })

  it('飛ばせるのはプロジェクトと文字起こしだけ', () => {
    expect(ONBOARDING_STEPS.filter((_, i) => isSkippableStep(i))).toEqual(['project', 'voice'])
  })

  it('再開: 最後に見ていた手順から始め、無い・知らない手順なら先頭', () => {
    expect(initialStepIndex(undefined)).toBe(0)
    expect(initialStepIndex(null)).toBe(0)
    expect(initialStepIndex({ lastStep: 'voice' })).toBe(3)
    expect(initialStepIndex({ lastStep: 'gone' as never })).toBe(0)
  })

  it('移るたびの保存値で再開位置が決まる（途中終了 → 再起動）', () => {
    const saved = applyOnboardingPatch(undefined, stepPatch(4))
    expect(saved).toEqual({ lastStep: 'permissions' })
    expect(shouldShowOnboarding(saved)).toBe(true)
    expect(initialStepIndex(saved)).toBe(4)
  })

  it('完了は completedAt を書いて再開位置を消す', () => {
    const done = applyOnboardingPatch({ lastStep: 'finish', dismissedAt: NOW }, completePatch(NOW))
    expect(done).toEqual({ completedAt: NOW })
    expect(shouldShowOnboarding(done)).toBe(false)
  })

  it('閉じる（スキップ）は dismissedAt を書き、開き直すと先頭から', () => {
    const skipped = applyOnboardingPatch({ lastStep: 'voice' }, dismissPatch(NOW))
    expect(skipped).toEqual({ dismissedAt: NOW })
    expect(shouldShowOnboarding(skipped)).toBe(false)
    const reopened = applyOnboardingPatch(skipped, reopenPatch())
    expect(shouldShowOnboarding(reopened)).toBe(true)
    expect(initialStepIndex(reopened)).toBe(0)
  })
})

describe('isContinueShortcut', () => {
  const key = (p: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p })

  it('macOS は ⌘↩、ほかは Ctrl+Enter', () => {
    expect(isContinueShortcut(key({ metaKey: true }), true)).toBe(true)
    expect(isContinueShortcut(key({ ctrlKey: true }), true)).toBe(false)
    expect(isContinueShortcut(key({ ctrlKey: true }), false)).toBe(true)
    expect(isContinueShortcut(key({ metaKey: true }), false)).toBe(false)
  })

  it('Enter だけ・Shift / Alt 付き・ほかのキーは進まない', () => {
    expect(isContinueShortcut(key({}), true)).toBe(false)
    expect(isContinueShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false)
    expect(isContinueShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(isContinueShortcut(key({ key: 'a', metaKey: true }), true)).toBe(false)
  })
})

describe('voiceModeOf', () => {
  it('提供元を3つの使い方にまとめる', () => {
    expect(voiceModeOf('local')).toBe('local')
    expect(voiceModeOf('compatible')).toBe('selfHosted')
    expect(voiceModeOf('openai')).toBe('cloud')
  })
})
