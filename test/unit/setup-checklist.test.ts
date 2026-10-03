import { describe, expect, it } from 'vitest'
import { setupChecklist, setupProgress, type SetupChecklistInput } from '../../src/renderer/onboarding/setupChecklistState'

/** 何も済んでいない macOS の状態 */
const empty: SetupChecklistInput = {
  platform: 'darwin',
  startupAgents: [],
  installedAgents: [],
  projectCount: 0,
  transcriptionReady: false,
  decisionReady: false,
  permissions: { microphone: 'not-determined', screen: 'not-determined' },
  reviewCount: 0,
  sentCount: 0
}
const doneOf = (input: SetupChecklistInput) => Object.fromEntries(setupChecklist(input).map((i) => [i.id, i.done]))

describe('セットアップのチェックリスト', () => {
  it('macOS では7項目（Agent → プロジェクト → 文字起こし → 判定モデル → 許可 → 録る → 送る）で、最初は全部未済', () => {
    const items = setupChecklist(empty)
    expect(items.map((i) => i.id)).toEqual(['agent', 'project', 'transcription', 'decision', 'permissions', 'firstRecording', 'firstSend'])
    expect(items.every((i) => !i.done)).toBe(true)
    expect(setupProgress(items)).toEqual({ done: 0, total: 7, complete: false })
  })

  it('macOS 以外は許可の項目を出さない（6項目）', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const items = setupChecklist({ ...empty, platform, permissions: { microphone: 'granted', screen: 'granted' } })
      expect(items.map((i) => i.id)).not.toContain('permissions')
      expect(items).toHaveLength(6)
    }
  })

  it('Agent は、選んだもののうち1つ以上がインストール済みのときだけ済み', () => {
    expect(doneOf({ ...empty, startupAgents: ['claude'], installedAgents: ['claude'] }).agent).toBe(true)
    expect(doneOf({ ...empty, startupAgents: ['claude'], installedAgents: ['codex'] }).agent).toBe(false)
    expect(doneOf({ ...empty, startupAgents: [], installedAgents: ['claude'] }).agent).toBe(false)
    // 探している途中は未済のまま（勝手に済みにしない）
    expect(doneOf({ ...empty, startupAgents: ['claude'], installedAgents: null }).agent).toBe(false)
  })

  it('プロジェクト・文字起こし・判定モデル', () => {
    expect(doneOf({ ...empty, projectCount: 1 }).project).toBe(true)
    expect(doneOf({ ...empty, transcriptionReady: true }).transcription).toBe(true)
    expect(doneOf({ ...empty, decisionReady: true }).decision).toBe(true)
  })

  it('許可はマイクが許可済みのときだけ済み（画面収録は見ない）。読めなければ未済', () => {
    expect(doneOf({ ...empty, permissions: { microphone: 'granted', screen: 'denied' } }).permissions).toBe(true)
    expect(doneOf({ ...empty, permissions: { microphone: 'denied', screen: 'granted' } }).permissions).toBe(false)
    expect(doneOf({ ...empty, permissions: null }).permissions).toBe(false)
  })

  it('録った（レビューが1件以上）・送った（sentAt のあるレビューが1件以上）', () => {
    expect(doneOf({ ...empty, reviewCount: 2, sentCount: 0 })).toMatchObject({ firstRecording: true, firstSend: false })
    expect(doneOf({ ...empty, reviewCount: 2, sentCount: 1 })).toMatchObject({ firstRecording: true, firstSend: true })
  })

  it('いくつか済んだとき・全部済んだときの進み具合', () => {
    const some = setupChecklist({ ...empty, startupAgents: ['claude'], installedAgents: ['claude'], projectCount: 1, transcriptionReady: true })
    expect(setupProgress(some)).toEqual({ done: 3, total: 7, complete: false })
    const all = setupChecklist({ ...empty, startupAgents: ['claude'], installedAgents: ['claude'], projectCount: 1, transcriptionReady: true,
      decisionReady: true, permissions: { microphone: 'granted', screen: 'granted' }, reviewCount: 1, sentCount: 1 })
    expect(setupProgress(all)).toEqual({ done: 7, total: 7, complete: true })
  })
})
