import type { AgentLaunchConfig, AgentPreferences, BuiltinAgent, CustomAgent, CustomAgentId, TuiAgent } from '@shared/types'
import { BUILTIN_AGENTS, DEFAULT_AGENT_PREFERENCES, newCustomAgentId } from '@shared/agentCatalog'

/**
 * 設定ページの Agents 節で行う変更（画面に依存しない純粋な関数。単体テストの対象）。
 * どれも新しい AgentPreferences を返し、元の値は変えない。保存（settings:agents）は呼び出し側が行う。
 */

/** 有効・無効の切り替え。無効にしたものは起動の対象からも外す（メニューに出ないものを自動で開かない） */
export function setAgentEnabled(prefs: AgentPreferences, id: TuiAgent, on: boolean): AgentPreferences {
  return {
    ...prefs,
    disabledAgents: on ? prefs.disabledAgents.filter((a) => a !== id) : [...new Set([...prefs.disabledAgents, id])],
    startupAgents: on ? prefs.startupAgents : prefs.startupAgents.filter((a) => a !== id)
  }
}

/** 起動するものは選んだ順に後ろへ足す。外すと詰める */
export function toggleStartupAgent(prefs: AgentPreferences, id: TuiAgent, on: boolean): AgentPreferences {
  const rest = prefs.startupAgents.filter((a) => a !== id)
  return { ...prefs, startupAgents: on ? [...rest, id] : rest }
}

export function setLaunchConfig(prefs: AgentPreferences, agent: BuiltinAgent, patch: Partial<AgentLaunchConfig>): AgentPreferences {
  return { ...prefs, launch: { ...prefs.launch, [agent]: { ...prefs.launch[agent], ...patch } } }
}

export function isDefaultLaunch(prefs: AgentPreferences, agent: BuiltinAgent): boolean {
  const current = prefs.launch[agent]
  const defaults = DEFAULT_AGENT_PREFERENCES.launch[agent]
  return current.command === defaults.command && current.args === defaults.args
}

export function resetLaunchConfig(prefs: AgentPreferences, agent: BuiltinAgent): AgentPreferences {
  return setLaunchConfig(prefs, agent, { ...DEFAULT_AGENT_PREFERENCES.launch[agent] })
}

/** 空のカスタムエージェントを足す。id は組み込み・既存のカスタムと重ならないように作る */
export function addCustomAgent(prefs: AgentPreferences): { prefs: AgentPreferences; id: CustomAgentId } {
  const id = newCustomAgentId('agent', [...BUILTIN_AGENTS, ...prefs.customAgents.map((c) => c.id)])
  return { prefs: { ...prefs, customAgents: [...prefs.customAgents, { id, name: '', command: '', args: '' }] }, id }
}

export function updateCustomAgent(prefs: AgentPreferences, id: CustomAgentId, patch: Partial<Omit<CustomAgent, 'id'>>): AgentPreferences {
  return { ...prefs, customAgents: prefs.customAgents.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
}

/** 削除したものは、無効・起動の一覧からも消す（指す先の無い id を残さない） */
export function removeCustomAgent(prefs: AgentPreferences, id: CustomAgentId): AgentPreferences {
  return {
    ...prefs,
    customAgents: prefs.customAgents.filter((c) => c.id !== id),
    disabledAgents: prefs.disabledAgents.filter((a) => a !== id),
    startupAgents: prefs.startupAgents.filter((a) => a !== id)
  }
}

/** 起動の候補に出すもの（有効なもの）。組み込みの並び → カスタムの並び */
export function startableAgents(prefs: AgentPreferences): TuiAgent[] {
  return [...BUILTIN_AGENTS, ...prefs.customAgents.map((c) => c.id)].filter((id) => !prefs.disabledAgents.includes(id))
}

/**
 * プロジェクトごとの「権限確認を省く」（security-3 [1]）。入れるときは confirm（パスと危険を見せた確認）が true を返したときだけ。
 * 外すときは確認しない。ほかのプロジェクトの許可には触らない
 */
export function setProjectBypass(prefs: AgentPreferences, projectId: string, on: boolean, confirm: () => boolean): AgentPreferences {
  const rest = prefs.bypassProjects.filter((id) => id !== projectId)
  if (!on) return rest.length === prefs.bypassProjects.length ? prefs : { ...prefs, bypassProjects: rest }
  if (prefs.bypassProjects.includes(projectId) || !confirm()) return prefs
  return { ...prefs, bypassProjects: [...rest, projectId] }
}
