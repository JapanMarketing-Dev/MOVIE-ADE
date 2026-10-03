import type { BuiltinAgent } from '@shared/types'
import { AGENT_CATALOG } from '@shared/agentCatalog'

/**
 * 見つからなかった Agent の CLI のインストールコマンド（AgentInstallTerminal で、押したときだけ実行する）。
 * 正本はカタログ（src/shared/agentCatalog.ts）の install。空のもの（ソースからしか入れられないなど）は undefined を返し、
 * インストール方法のリンクだけを出す。
 */
export function agentInstallCommand(agent: BuiltinAgent): string | undefined {
  return AGENT_CATALOG[agent]?.install.trim() || undefined
}
