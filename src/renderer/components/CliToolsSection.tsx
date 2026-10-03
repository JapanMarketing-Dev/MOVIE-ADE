import { Copy, Download, ExternalLink, LogIn, RotateCw } from 'lucide-react'
import { CLI_TOOL_IDS, CLI_TOOLS, type CliToolCategory, type CliToolId, type CliToolStatus } from '@shared/cliTools'
import type { TranslationKey } from '@shared/i18n'
import { Button, IconButton, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { cliActionCommand, runCliAction, useCliTools, type CliAction } from '../lib/cliTools'
import '../styles/cliTools.css'

/**
 * 設定の「CLI」。よく使うサービスの CLI（gh・glab・wrangler・Ollama・Vercel・AWS など）が入っているか・版と、
 * インストール・ログインのボタン。ボタンは公式のコマンドを内蔵ターミナルの新しいタブで走らせる（ページへは飛ばさない）。
 * インストールを始めたものは、見つかるまで一覧が自分で検出し直す。
 */

const CATEGORY_ORDER: readonly CliToolCategory[] = ['git', 'ai', 'deploy', 'cloud']
const CATEGORY_LABEL: Record<CliToolCategory, TranslationKey> = {
  git: 'cliTools.category.git', ai: 'cliTools.category.ai', deploy: 'cliTools.category.deploy', cloud: 'cliTools.category.cloud'
}

export function CliToolsSection() {
  const t = useT()
  const cli = useCliTools()
  return <div className="cli-tools" data-testid="cli-tools">
    <p className="st-note">{t('cliTools.intro')}</p>
    <div className="st-key__actions">
      <Button variant="ghost" icon={<RotateCw size={13} />} onClick={() => void cli.refresh()} data-testid="cli-tools-refresh">{t('cliTools.recheck')}</Button>
    </div>
    {CATEGORY_ORDER.map((category) => <div key={category} className="cli-tools__group">
      <h3 className="st-page__subheading">{t(CATEGORY_LABEL[category])}</h3>
      {CLI_TOOL_IDS.filter((id) => CLI_TOOLS[id].category === category).map((id) =>
        <CliToolRow key={id} id={id} status={cli.tools?.find((tool) => tool.id === id) ?? null} loading={cli.tools === null}
          watching={cli.watching.has(id)} onInstallStarted={() => cli.watch(id)} />)}
    </div>)}
  </div>
}

/**
 * 1つの CLI の行（名前・入っているか・版・インストール／ログイン）。判定モデルの欄（wrangler・Ollama）からも使う
 */
export function CliToolRow({ id, status, loading, watching, onInstallStarted, compact }: {
  id: CliToolId
  status: CliToolStatus | null
  loading: boolean
  watching: boolean
  onInstallStarted: () => void
  /** 欄の中に置く小さい形（名前と版とボタンだけ） */
  compact?: boolean
}) {
  const t = useT()
  const toast = useToast()
  const entry = CLI_TOOLS[id]
  const installCommand = cliActionCommand(id, 'install')
  const loginCommand = cliActionCommand(id, 'login')

  const run = (action: CliAction) => {
    const title = t(action === 'install' ? 'cliTools.installTabTitle' : 'cliTools.loginTabTitle', { tool: entry.label })
    void runCliAction(id, action, title).then(({ result, command }) => {
      if (result === 'terminal') {
        toast({ tone: 'info', message: t('cliTools.sent'), detail: t(action === 'install' ? 'cliTools.sentInstallDetail' : 'cliTools.sentLoginDetail') })
        if (action === 'install') onInstallStarted()
      } else if (result === 'copied') {
        toast({ tone: 'info', message: t('cliTools.copied', { command: command ?? '' }) })
        if (action === 'install') onInstallStarted()
      } else {
        toast({ tone: 'danger', message: t('cliTools.failed') })
      }
    })
  }
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast({ tone: 'success', message: t('common.copied') }), () => {})
  const docs = () => void window.ade.invoke('app:openExternal', entry.homepageUrl).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る

  const installed = status?.installed === true
  return <div className={`cli-tool${compact ? ' cli-tool--compact' : ''}`} data-testid={`cli-tool-${id}`} data-installed={installed || undefined}>
    <div className="cli-tool__head">
      <span className="cli-tool__name">{entry.label}</span>
      <code className="cli-tool__cmd">{entry.detectCmd}</code>
      {loading && <Spinner size={12} />}
      {!loading && installed && <span className="st-agent-row__state">{t('settings.agents.installed')}{status?.version ? ` · v${status.version}` : ''}</span>}
      {!loading && !installed && !watching && <span className="st-agent-row__state is-missing">{t('settings.agents.notFound')}</span>}
      {!loading && !installed && watching && <span className="st-agent-row__state" role="status"><Spinner size={11} />{t('cliTools.waitingInstall')}</span>}
      <span className="cli-tool__actions">
        {!installed && installCommand && <Button icon={<Download size={13} />} onClick={() => run('install')} data-testid={`cli-tool-${id}-install`}>{t('agentInstall.install')}</Button>}
        {installed && loginCommand && <Button variant="ghost" icon={<LogIn size={13} />} onClick={() => run('login')} data-testid={`cli-tool-${id}-login`}>{t('cliTools.login')}</Button>}
        {!installed && !installCommand && <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={docs}>{t('cliTools.docs')}</Button>}
      </span>
    </div>
    {!installed && installCommand && !compact && <div className="cli-tool__command">
      <code title={installCommand}>{installCommand}</code>
      <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={12} />} onClick={() => copy(installCommand)} />
    </div>}
    {!installed && !installCommand && <p className="st-note">{t('cliTools.noCommand')}</p>}
  </div>
}
