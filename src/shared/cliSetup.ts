/**
 * AI の接続先の欄（判定モデル・文字起こし・整理）で、設定に役立つ CLI を選ぶ（画面に依存しない純粋な関数）。
 *
 * 例: Cloudflare の Account ID は、wrangler を入れてログインしておけば Agent が `wrangler whoami` で読める。
 * Agent への指示文そのもの（CLI を入れて使う手順を含む）は setupGuide.ts の buildAgentSetupPrompt が作る。
 */
import { cliToolForInstallUrl, type CliToolId } from './cliTools'

/** 案内に使う CLI を選ぶのに要る、提供元の情報（SetupGuide の一部） */
interface CliSetupGuide {
  needsAccountId?: boolean
  local?: boolean
  installUrl?: string
}

/**
 * その提供元の設定に役立つ CLI。Cloudflare（Account ID が要る）は wrangler、端末内の Ollama は ollama。
 * 当てはまらなければ null
 */
export function setupCliTool(guide: CliSetupGuide): CliToolId | null {
  if (guide.needsAccountId) return 'wrangler'
  if (guide.local) return cliToolForInstallUrl(guide.installUrl)
  return null
}
