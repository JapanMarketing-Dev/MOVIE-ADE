import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentResourceList } from '@shared/agentResources'
import type { TuiAgent } from '@shared/types'
import { app } from 'electron'
import { currentSettings } from '../settings'
import { verifyManagedAccountDir } from '../accounts/paths'
import { readClaudeResources, readCodexResources, readGeminiResources } from './readers'
import type { Collector } from './read'

/**
 * 設定の Agents の節に出す、Agent CLI ごとのスキル・スラッシュコマンド・MCP サーバー。
 * 開いたときと再読み込みのときだけ読む（非同期・上限つき）。どのファイルも書き換えない。
 */

/**
 * その CLI が実際に使う設定フォルダ。選択中のアカウント（追加したアカウントなら CLAUDE_CONFIG_DIR / CODEX_HOME）を優先し、
 * 無ければ環境変数、それも無ければ既定の場所。
 */
function configDirFor(agent: 'claude' | 'codex'): { dir: string; inherited: boolean } {
  // 起動時の resolveAgentEnv は手直し（書き込み）を伴うので使わず、選択中のアカウントのフォルダを確かめるだけにする
  const list = currentSettings().agentAccounts?.[agent]
  const activeId = list?.accounts.some((a) => a.id === list.activeAccountId) ? list.activeAccountId : null
  if (activeId) {
    const verdict = verifyManagedAccountDir({ userDataDir: app.getPath('userData'), agent, accountId: activeId })
    if (verdict.kind === 'owned') return { dir: verdict.dir, inherited: true }
  }
  const key = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  const fromEnv = process.env[key]?.trim()
  if (fromEnv) return { dir: fromEnv, inherited: true }
  return { dir: join(homedir(), agent === 'claude' ? '.claude' : '.codex'), inherited: false }
}

function toList(agent: TuiAgent, collector: Collector): AgentResourceList {
  return { agent, supported: true, items: collector.items, warnings: collector.warnings }
}

export async function listAgentResources(agent: TuiAgent, projectDir: string | null): Promise<AgentResourceList> {
  if (agent === 'claude') {
    const { dir, inherited } = configDirFor('claude')
    return toList(agent, await readClaudeResources({ configDir: dir, inheritedConfigDir: inherited, projectDir }))
  }
  if (agent === 'codex') return toList(agent, await readCodexResources({ codexHome: configDirFor('codex').dir }))
  if (agent === 'gemini') return toList(agent, await readGeminiResources({ geminiHome: join(homedir(), '.gemini'), projectDir }))
  return { agent, supported: false, items: [], warnings: [] }
}
