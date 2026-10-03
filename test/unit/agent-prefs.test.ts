import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, DEFAULT_AGENT_PREFERENCES } from '@shared/agentCatalog'
import type { AgentPreferences } from '@shared/types'
import {
  addCustomAgent,
  isDefaultLaunch,
  removeCustomAgent,
  resetLaunchConfig,
  setAgentEnabled,
  setLaunchConfig,
  startableAgents,
  toggleStartupAgent,
  updateCustomAgent
} from '../../src/renderer/lib/agentPrefs'

const base = (patch: Partial<AgentPreferences> = {}): AgentPreferences => ({
  ...DEFAULT_AGENT_PREFERENCES,
  customAgents: [],
  disabledAgents: [],
  startupAgents: [],
  ...patch
})

describe('設定ページの Agents 節の変更', () => {
  it('起動するエージェントは選んだ順に並び、外すと詰まる', () => {
    let prefs = toggleStartupAgent(base(), 'codex', true)
    prefs = toggleStartupAgent(prefs, 'claude', true)
    prefs = toggleStartupAgent(prefs, 'gemini', true)
    expect(prefs.startupAgents).toEqual(['codex', 'claude', 'gemini'])
    expect(toggleStartupAgent(prefs, 'claude', false).startupAgents).toEqual(['codex', 'gemini'])
    // 二重には入らない（選び直すと最後へ）
    expect(toggleStartupAgent(prefs, 'codex', true).startupAgents).toEqual(['claude', 'gemini', 'codex'])
  })

  it('無効にすると起動の対象からも外れ、候補にも出ない。有効に戻すと候補に戻る', () => {
    const prefs = setAgentEnabled(base({ startupAgents: ['claude', 'codex'] }), 'claude', false)
    expect(prefs.disabledAgents).toEqual(['claude'])
    expect(prefs.startupAgents).toEqual(['codex'])
    expect(startableAgents(prefs)).not.toContain('claude')
    expect(setAgentEnabled(setAgentEnabled(prefs, 'claude', false), 'claude', true).disabledAgents).toEqual([])
  })

  it('コマンドと引数は1件ずつ変えられ、既定に戻せる', () => {
    const changed = setLaunchConfig(base(), 'gemini', { args: '' })
    expect(isDefaultLaunch(changed, 'gemini')).toBe(false)
    expect(changed.launch.claude).toEqual(DEFAULT_AGENT_PREFERENCES.launch.claude)
    expect(isDefaultLaunch(resetLaunchConfig(changed, 'gemini'), 'gemini')).toBe(true)
  })

  it('カスタムエージェントは重ならない id で足し、編集・削除できる。削除すると無効・起動の一覧からも消える', () => {
    const first = addCustomAgent(base())
    const second = addCustomAgent(first.prefs)
    expect(first.id).toMatch(/^custom:/)
    expect(second.id).not.toBe(first.id)
    let prefs = updateCustomAgent(second.prefs, first.id, { name: 'My Agent', command: 'my-agent', processName: 'node' })
    expect(prefs.customAgents[0]).toEqual({ id: first.id, name: 'My Agent', command: 'my-agent', args: '', processName: 'node' })
    prefs = toggleStartupAgent(setAgentEnabled(prefs, second.id, false), first.id, true)
    expect(startableAgents(prefs)).toEqual([...BUILTIN_AGENTS, first.id])
    const removed = removeCustomAgent(removeCustomAgent(prefs, first.id), second.id)
    expect(removed.customAgents).toEqual([])
    expect(removed.startupAgents).toEqual([])
    expect(removed.disabledAgents).toEqual([])
  })
})
