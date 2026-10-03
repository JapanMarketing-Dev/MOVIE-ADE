import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Copy, ExternalLink, GitPullRequest, LogIn, LogOut, RefreshCw } from 'lucide-react'
import type { GitHubRepoResult, GitHubStatus } from '@shared/github'
import { Badge, Button, IconButton, Spinner, Tooltip, useToast } from '../ui'
import { errorMessage } from '../lib/errors'
import { requestTerminalCommand } from '../lib/terminalCommand'
import { useT } from '../lib/i18n'
import '../styles/github.css'

/**
 * 設定画面の「GitHub」欄。接続状態・ログイン／ログアウトの案内・今のプロジェクトのリポジトリを出す。
 * PR・Issue の一覧は持たない（GitHub はレビュー結果の送り先としてだけ使う）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/settings/cli-source-control-integration-cards.tsx
 *           （gh が無い・未認証のときの案内と文言）,
 *           ~/bench/orca/src/renderer/src/components/github-project/GhAuthErrorHelp.tsx（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく認証は GitHub CLI（gh）に任せる。ログイン・ログアウトは内蔵ターミナルで gh を走らせる。
 * 本システムはトークンを読まず、画面にも出さない。
 */

const LOGIN_COMMAND = 'gh auth login --web -h github.com'
const logoutCommand = (host: string) => `gh auth logout -h ${host}`

function openOnGitHub(url: string) {
  void window.ade.invoke('github:open', url).catch(() => {}) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
}

export function GitHubSection() {
  const t = useT()
  const toast = useToast()
  const [status, setStatus] = useState<GitHubStatus | null>(null)
  const [repo, setRepo] = useState<GitHubRepoResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextStatus, nextRepo] = await Promise.all([window.ade.invoke('github:status'), window.ade.invoke('github:repo')])
      setStatus(nextStatus)
      setRepo(nextRepo)
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

  return <section className="st-section gh-section" id="settings-github" data-testid="settings-github">
    <h3 className="st-section__title">
      <span className="st-section__icon gh-section__icon" aria-hidden="true"><GitPullRequest size={14} /></span>
      GitHub
      <span className="gh-section__refresh">
        <Tooltip label={t('common.reload')} side="bottom">
          <IconButton size="sm" label={t('github.reloadStatus')} icon={loading ? <Spinner size={13} /> : <RefreshCw size={13} />} disabled={loading} onClick={() => void load()} />
        </Tooltip>
      </span>
    </h3>
    <div className="st-section__body">
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
          <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => openOnGitHub('https://github.com/cli/cli#installation')}>{t('github.howToInstall')}</Button>
        </div>
      </div>}

      {status?.ghInstalled && !account && <div className="gh-callout" role="status">
        <p className="gh-callout__title"><CircleAlert size={13} aria-hidden="true" />{t('github.notSignedIn')}</p>
        <p className="st-note">{(() => {
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
        <Button variant="ghost" icon={<LogOut size={13} />} onClick={() => runInTerminal(logoutCommand(account.host), t('github.logoutTabTitle'))}>{t('github.signOut')}</Button>
      </div>}
      {account?.source === 'env' && <p className="st-note st-note--warn">
        <CircleAlert size={12} aria-hidden="true" />{t('github.envTokenWarning')}
      </p>}
      {status?.error && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{status.error}</p>}

      {repo && <div className="st-row">
        <span className="st-row__label">{t('github.repository')}</span>
        {repo.repo
          ? <button type="button" className="gh-repo" onClick={() => openOnGitHub(repo.repo!.webUrl)} title={t('common.openInBrowser')}>
            {repo.repo.owner}/{repo.repo.repo}<ExternalLink size={12} aria-hidden="true" />
          </button>
          : <span className="gh-muted">{repo.reason}</span>}
      </div>}

    </div>
  </section>
}
