import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Copy, Download, ExternalLink, GitPullRequest, LogIn, LogOut, RefreshCw } from 'lucide-react'
import type { GitHubRepoResult, GitHubStatus } from '@shared/github'
import { GITLAB_COM, cliLoginCommand, cliLogoutCommand, forgeLabel, type GitLabStatus } from '@shared/forge'
import { CLI_TOOLS, cliInstallCommand } from '@shared/cliTools'
import { Badge, Button, IconButton, Spinner, Tooltip, useToast } from '../ui'
import { errorMessage } from '../lib/errors'
import { requestTerminalCommand } from '../lib/terminalCommand'
import { useT } from '../lib/i18n'
import '../styles/github.css'

/**
 * 設定画面の「GitHub / GitLab」欄。接続状態・インストールとログイン／ログアウトの案内・今のプロジェクトのリポジトリを出す。
 * GitLab（gitlab.com とセルフホスト）は glab CLI に認証を任せる。CLI が無い・未ログインなら、入れる／ログインするコマンドを
 * 内蔵ターミナルへ送るボタンを出す（コマンドは src/shared/forge.ts の決まった形だけ。入力をそのまま混ぜない）。
 * PR・Issue の一覧は持たない（GitHub はレビュー結果の送り先としてだけ使う）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/settings/cli-source-control-integration-cards.tsx
 *           （gh が無い・未認証のときの案内と文言）,
 *           ~/bench/orca/src/renderer/src/components/github-project/GhAuthErrorHelp.tsx（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく認証は GitHub CLI（gh）に任せる。ログイン・ログアウトは内蔵ターミナルで gh を走らせる。
 * 本システムはトークンを読まず、画面にも出さない。
 */

const LOGIN_COMMAND = cliLoginCommand('gh')

function openOnGitHub(url: string) {
  void window.ade.invoke('github:open', url).catch(() => {}) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
}

export function GitHubSection() {
  const t = useT()
  const toast = useToast()
  const [status, setStatus] = useState<GitHubStatus | null>(null)
  const [repo, setRepo] = useState<GitHubRepoResult | null>(null)
  const [gitlab, setGitlab] = useState<GitLabStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextStatus, nextRepo, nextGitlab] = await Promise.all([window.ade.invoke('github:status'), window.ade.invoke('github:repo'), window.ade.invoke('gitlab:status')])
      setStatus(nextStatus)
      setRepo(nextRepo)
      setGitlab(nextGitlab)
    } catch (err) {
      toast({ tone: 'danger', message: t('github.loadFailed'), detail: errorMessage(err) })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    void load()
    // プロジェクトを切り替えたら、リポジトリを読み直す
    return window.ade.on('workspace:changed', () => void load())
  }, [load])

  /** 内蔵ターミナルで gh を走らせる。ターミナルが受け取れなければコマンドを写して案内する */
  const runInTerminal = (command: string, title: string) => {
    if (requestTerminalCommand({ command, title })) {
      toast({ tone: 'info', message: t('github.continueInTerminal'), detail: t('github.continueInTerminalDetail') })
      return
    }
    void navigator.clipboard.writeText(command).then(
      () => toast({ tone: 'info', message: t('github.commandCopied'), detail: t('github.commandCopiedDetail', { command }) }),
      () => toast({ tone: 'warning', message: t('github.runInTerminal', { command }) })
    )
  }

  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast({ tone: 'success', message: t('common.copied') }), () => {})

  const account = status?.account ?? null
  const ghInstall = cliInstallCommand('gh', window.ade.platform)
  const logout = account ? cliLogoutCommand('gh', account.host) : null

  return <section className="st-section gh-section" id="settings-github" data-testid="settings-github">
    <h3 className="st-section__title">
      <span className="st-section__icon gh-section__icon" aria-hidden="true"><GitPullRequest size={14} /></span>
      GitHub / GitLab
      <span className="gh-section__refresh">
        <Tooltip label={t('common.reload')} side="bottom">
          <IconButton size="sm" label={t('github.reloadStatus')} icon={loading ? <Spinner size={13} /> : <RefreshCw size={13} />} disabled={loading} onClick={() => void load()} />
        </Tooltip>
      </span>
    </h3>
    <div className="st-section__body">
      <h4 className="gh-section__sub">GitHub</h4>
      <p className="st-note">{t('github.intro')}</p>

      {!status && <p className="st-note"><Spinner size={12} />{t('common.checking')}</p>}

      {status && !status.ghInstalled && <div className="gh-callout" role="status">
        <p className="gh-callout__title"><CircleAlert size={13} aria-hidden="true" />{t('github.notInstalled')}</p>
        <p className="st-note">{t('github.installThenReload')}</p>
        <div className="gh-command">
          <code>{status.installHint}</code>
          <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={13} />} onClick={() => copy(status.installHint)} />
        </div>
        <div className="gh-actions">
          {ghInstall && <Button icon={<Download size={13} />} onClick={() => runInTerminal(ghInstall, t('github.installTabTitle', { cli: 'gh' }))} data-testid="gh-install-terminal">{t('github.installInTerminal')}</Button>}
          <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => openOnGitHub(CLI_TOOLS.gh.homepageUrl)}>{t('github.howToInstall')}</Button>
        </div>
      </div>}

      {status?.ghInstalled && !account && <div className="gh-callout" role="status">
        <p className="gh-callout__title"><CircleAlert size={13} aria-hidden="true" />{t('github.notSignedIn')}</p>
        <p className="st-note gh-callout__help">{(() => {
          // 文の中のコマンドだけを <code> にする。語順は言語ごとに違うので、辞書の {{command}} の位置で分ける
          const [before, after = ''] = t('github.loginHelp', { command: '\0' }).split('\0')
          return <>{before}<code>{LOGIN_COMMAND}</code>{after}</>
        })()}</p>
        <div className="gh-actions">
          <Button icon={<LogIn size={13} />} onClick={() => runInTerminal(LOGIN_COMMAND, t('github.loginTabTitle'))}>{t('github.signInInTerminal')}</Button>
          <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={13} />} onClick={() => copy(LOGIN_COMMAND)} />
        </div>
      </div>}

      {account && <div className="st-row gh-account">
        <span className="st-row__label">
          <CircleCheck size={13} className="gh-ok" aria-hidden="true" />
          <span className="gh-account__name">{account.user}</span>
          <span className="gh-account__host">{account.host}</span>
          {account.source === 'env' && <Badge tone="warning">{t('github.envToken')}</Badge>}
        </span>
        {logout && <Button variant="ghost" icon={<LogOut size={13} />} onClick={() => runInTerminal(logout, t('github.logoutTabTitle'))}>{t('github.signOut')}</Button>}
      </div>}
      {account?.source === 'env' && <p className="st-note st-note--warn">
        <CircleAlert size={12} aria-hidden="true" />{t('github.envTokenWarning')}
      </p>}
      {status?.error && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{status.error}</p>}

      <GitLabBlock status={gitlab} runInTerminal={runInTerminal} copy={copy} />

      {repo && <div className="st-row">
        <span className="st-row__label">{t('github.repository')}</span>
        {repo.repo
          ? <button type="button" className="gh-repo" onClick={() => openOnGitHub(repo.repo!.webUrl)} title={t('common.openInBrowser')}>
            {forgeLabel(repo.repo.forge ?? 'github')} · {repo.repo.owner}/{repo.repo.repo}<ExternalLink size={12} aria-hidden="true" />
          </button>
          : <span className="gh-muted">{repo.reason}</span>}
      </div>}

    </div>
  </section>
}

/** GitLab（glab）の接続状態。glab が無い・未ログインなら、入れる／ログインするコマンドを内蔵ターミナルへ送る */
function GitLabBlock({ status, runInTerminal, copy }: {
  status: GitLabStatus | null
  runInTerminal: (command: string, title: string) => void
  copy: (text: string) => void
}) {
  const t = useT()
  const signedIn = status?.accounts.filter((a) => a.user) ?? []
  // 今のプロジェクトがセルフホストの GitLab で、そのホストに未ログインなら、そのホストへのログインを出す
  const loginHost = status?.projectHost && !signedIn.some((a) => a.host === status.projectHost) ? status.projectHost : signedIn.length === 0 ? GITLAB_COM : null
  const loginCommand = loginHost ? cliLoginCommand('glab', loginHost) : null

  return <div className="gh-section__gitlab" data-testid="settings-gitlab">
    <h4 className="gh-section__sub">GitLab</h4>
    <p className="st-note">{t('gitlab.intro')}</p>
    {!status && <p className="st-note"><Spinner size={12} />{t('common.checking')}</p>}

    {status && !status.glabInstalled && <div className="gh-callout" role="status">
      <p className="gh-callout__title"><CircleAlert size={13} aria-hidden="true" />{t('gitlab.notInstalled')}</p>
      <p className="st-note">{t('github.installThenReload')}</p>
      {status.installCommand && <div className="gh-command">
        <code>{status.installCommand}</code>
        <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={13} />} onClick={() => copy(status.installCommand!)} />
      </div>}
      <div className="gh-actions">
        {status.installCommand && <Button icon={<Download size={13} />} onClick={() => runInTerminal(status.installCommand!, t('github.installTabTitle', { cli: 'glab' }))} data-testid="glab-install-terminal">{t('github.installInTerminal')}</Button>}
        <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void window.ade.invoke('app:openExternal', CLI_TOOLS.glab.homepageUrl).catch(() => {})}>{t('github.howToInstall')}</Button>
      </div>
    </div>}

    {status?.glabInstalled && loginCommand && <div className="gh-callout" role="status">
      <p className="gh-callout__title"><CircleAlert size={13} aria-hidden="true" />{t('gitlab.notSignedIn', { host: loginHost! })}</p>
      <p className="st-note gh-callout__help">{(() => {
        const [before, after = ''] = t('gitlab.loginHelp', { command: '\0' }).split('\0')
        return <>{before}<code>{loginCommand}</code>{after}</>
      })()}</p>
      <div className="gh-actions">
        <Button icon={<LogIn size={13} />} onClick={() => runInTerminal(loginCommand, t('gitlab.loginTabTitle'))} data-testid="glab-login-terminal">{t('github.signInInTerminal')}</Button>
        <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={13} />} onClick={() => copy(loginCommand)} />
      </div>
    </div>}

    {signedIn.map((a) => {
      const logout = cliLogoutCommand('glab', a.host)
      return <div key={a.host} className="st-row gh-account">
        <span className="st-row__label">
          <CircleCheck size={13} className="gh-ok" aria-hidden="true" />
          <span className="gh-account__name">{a.user}</span>
          <span className="gh-account__host">{a.host}</span>
          {status?.envToken && <Badge tone="warning">{t('github.envToken')}</Badge>}
        </span>
        {logout && <Button variant="ghost" icon={<LogOut size={13} />} onClick={() => runInTerminal(logout, t('gitlab.logoutTabTitle'))}>{t('github.signOut')}</Button>}
      </div>
    })}
    {status?.envToken && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('gitlab.envTokenWarning', { name: status.envToken })}</p>}
    {status?.error && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{status.error}</p>}
  </div>
}
