import type { BuiltinAgent } from '@shared/types'

/**
 * セットアップの Agent の手順で、見つからなかった CLI に出す入れ方（コピーして自分で実行してもらう）。
 * 本システムがインストーラを動かすことはない。
 * 公式の手順が npm 以外で、短い1行にできないものは載せず、ホームページ（agentCatalog の homepageUrl）だけを案内する。
 */
export const AGENT_INSTALL_COMMANDS: Partial<Record<BuiltinAgent, string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  opencode: 'npm install -g opencode-ai',
  copilot: 'npm install -g @github/copilot',
  'qwen-code': 'npm install -g @qwen-code/qwen-code',
  amp: 'npm install -g @sourcegraph/amp'
}
