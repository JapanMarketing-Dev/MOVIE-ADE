import { Copy, Download, ExternalLink, LogIn, RotateCw } from 'lucide-react'
import {
  CLI_TOOL_CATEGORIES,
  CLI_TOOL_IDS,
  CLI_TOOLS,
  cliDisplayCommand,
  cliSiteHost,
  cliToolSupported,
  type CliToolCategory,
  type CliToolId,
  type CliToolOs,
  type CliToolStatus
} from '@shared/cliTools'
import type { TranslationKey } from '@shared/i18n'
import { Button, IconButton, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { cliActionCommand, currentPlatform, runCliAction, useCliTools, type CliAction } from '../lib/cliTools'
import '../styles/cliTools.css'

/**
 * 設定の「よく使うサービスの CLI」。Git のホスティング・デプロイ先・クラウド・データベース・エラー監視・決済・コンテナ・
 * モバイル・仮想マシン（UTM など）・AI の CLI が入っているか・版と、サービスのサイトへのリンク、インストール・ログインのボタン。
 * どれも入れるのは任意で、入っていないものは警告にせず「未インストール」と出す。
 * ボタンは公式のコマンドを内蔵ターミナルの新しいタブで走らせる（ページへは飛ばさない）。
 * インストールを始めたものは、見つかるまで一覧が自分で検出し直す。
 */

const CATEGORY_LABEL: Record<CliToolCategory, TranslationKey> = {
  git: 'cliTools.category.git',
  deploy: 'cliTools.category.deploy',
  cloud: 'cliTools.category.cloud',
  database: 'cliTools.category.database',
  monitoring: 'cliTools.category.monitoring',
  payments: 'cliTools.category.payments',
  containers: 'cliTools.category.containers',
  mobile: 'cliTools.category.mobile',
  vm: 'cliTools.category.vm',
  ai: 'cliTools.category.ai'
}

const OS_LABEL: Record<CliToolOs, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

export function CliToolsSection() {
  const t = useT()
  const cli = useCliTools()
  return <div className="cli-tools" data-testid="cli-tools">
    <p className="st-note">{t('cliTools.intro')}</p>
    <div className="st-key__actions">
      <Button variant="ghost" icon={<RotateCw size={13} />} onClick={() => void cli.refresh()} data-testid="cli-tools-refresh">{t('cliTools.recheck')}</Button>
    </div>
    {CLI_TOOL_CATEGORIES.map((category) => <div key={category} className="cli-tools__group" data-testid={`cli-tools-group-${category}`}>
      <h3 className="st-page__subheading">{t(CATEGORY_LABEL[category])}</h3>
      {CLI_TOOL_IDS.filter((id) => CLI_TOOLS[id].category === category).map((id) =>
        <CliToolRow key={id} id={id} status={cli.tools?.find((tool) => tool.id === id) ?? null} loading={cli.tools === null}
          watching={cli.watching.has(id)} onInstallStarted={() => cli.watch(id)} />)}
    </div>)}
  </div>
}

/**
 * 1つの CLI の行（名前・サイト・入っているか・版・インストール／ログイン）。判定モデルの欄（wrangler・Ollama）からも使う
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
  const supported = cliToolSupported(id, currentPlatform())
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
  // 開くのは main の app:openExternal（https だけを通す）。失敗は main の IPC が Sentry へ送る
  const open = (url: string) => void window.ade.invoke('app:openExternal', url).catch(() => undefined)

  const installed = status?.installed === true
  const onlyOn = entry.platforms?.map((os) => OS_LABEL[os]).join(' / ') ?? ''
  return <div className={`cli-tool${compact ? ' cli-tool--compact' : ''}`} data-testid={`cli-tool-${id}`} data-installed={installed || undefined}
    data-supported={supported || undefined}>
    <div className="cli-tool__head">
      <span className="cli-tool__name">{entry.label}</span>
      <code className="cli-tool__cmd">{cliDisplayCommand(id)}</code>
      {!compact && <button type="button" className="st-link cli-tool__site" title={entry.siteUrl} data-testid={`cli-tool-${id}-site`}
        onClick={() => open(entry.siteUrl)}>
        <ExternalLink size={12} aria-hidden="true" />{cliSiteHost(id)}
      </button>}
      {!supported && <span className="st-agent-row__state" data-testid={`cli-tool-${id}-only`}>{t('cliTools.onlyOn', { os: onlyOn })}</span>}
      {supported && loading && <Spinner size={12} />}
      {supported && !loading && installed && <span className="st-agent-row__state">{t('settings.agents.installed')}{status?.version ? ` · v${status.version}` : ''}</span>}
      {supported && !loading && !installed && !watching && <span className="st-agent-row__state">{t('cliTools.notInstalled')}</span>}
      {supported && !loading && !installed && watching && <span className="st-agent-row__state" role="status"><Spinner size={11} />{t('cliTools.waitingInstall')}</span>}
      <span className="cli-tool__actions">
        {supported && !installed && installCommand && <Button icon={<Download size={13} />} onClick={() => run('install')} data-testid={`cli-tool-${id}-install`}>{t('agentInstall.install')}</Button>}
        {supported && installed && loginCommand && <Button variant="ghost" icon={<LogIn size={13} />} onClick={() => run('login')} data-testid={`cli-tool-${id}-login`}>{t('cliTools.login')}</Button>}
        {supported && !installed && !installCommand && <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => open(entry.homepageUrl)}>{t('cliTools.docs')}</Button>}
      </span>
    </div>
    {supported && !installed && installCommand && !compact && <div className="cli-tool__command">
      <code title={installCommand}>{installCommand}</code>
      <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={12} />} onClick={() => copy(installCommand)} />
    </div>}
    {supported && !installed && !installCommand && <p className="st-note">{t('cliTools.noCommand')}</p>}
  </div>
}
