import type { CliToolId } from '@shared/cliTools'
import { useT } from '../lib/i18n'
import { useCliTools } from '../lib/cliTools'
import { CliToolRow } from './CliToolsSection'

/**
 * AI の接続先の欄（判定モデル・文字起こし・整理）に置く、設定に役立つ CLI の1行。
 * Cloudflare は wrangler（入れてログインしておけば、Agent が Account ID を調べられる）、Ollama は ollama 本体。
 * ダウンロードのページへ飛ばさず、内蔵ターミナルで公式のコマンドを走らせる。
 */
export function CliAssist({ tool }: { tool: CliToolId }) {
  const t = useT()
  const cli = useCliTools()
  return <div className="cli-assist" data-testid={`cli-assist-${tool}`}>
    <CliToolRow compact id={tool} status={cli.tools?.find((s) => s.id === tool) ?? null} loading={cli.tools === null}
      watching={cli.watching.has(tool)} onInstallStarted={() => cli.watch(tool)} />
    <p className="st-note">{t(tool === 'wrangler' ? 'cliSetup.wranglerNote' : 'cliSetup.ollamaNote')}</p>
  </div>
}
