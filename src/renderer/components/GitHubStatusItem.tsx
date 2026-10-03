import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ExternalLink, GitBranch } from 'lucide-react'
import { branchWebUrl, type GitRepoStatus } from '@shared/github'
import { useT } from '../lib/i18n'
import { subscribeIpc } from '../lib/ipcEvents'
import { StatusPopover } from './StatusPopover'
import '../styles/github.css'

/**
 * フッターの「どの GitHub / GitLab の、どのブランチか」。例: [GitHub] JapanMarketing-Dev/ferret · develop •3 ↑1
 *
 * 読み直すのは、プロジェクトの切り替え・ウインドウを前に出したとき・30 秒ごと・.git/HEAD と index の変化（main が知らせる）。
 * git でないフォルダでは何も出さない（後ろの区切り線も含めて。線だけが残らないよう、区切り線はこの部品が出す）。GitHub 以外の remote のときはブランチだけを出す。
 * 押すと「リポジトリを開く」「ブランチを開く」のメニュー。GitHub のページを開くだけで、書き込みはしない。
 */

const POLL_MS = 30_000

/** GitHub のマーク（単色）。Octicons の mark-github（MIT） */
function GitHubMark({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
}

/** GitLab のマーク（単色）。Simple Icons の gitlab（CC0） */
function GitLabMark({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.919 1.263a.455.455 0 0 0-.867 0L1.386 9.45.044 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.625-8.443a.92.92 0 0 0 .33-1.024" />
  </svg>
}

export function GitHubStatusItem() {
  const t = useT()
  const [status, setStatus] = useState<GitRepoStatus | null>(null)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const loading = useRef(false)

  const load = useCallback(async () => {
    // 前の読み取りが終わっていなければ重ねない
    if (loading.current) return
    loading.current = true
    try {
      setStatus(await window.ade.invoke('github:repoStatus'))
    } catch { // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      setStatus(null)
    } finally {
      loading.current = false
    }
  }, [])

  useEffect(() => {
    void load()
    const reload = () => void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') reload() }, POLL_MS)
    window.addEventListener('focus', reload)
    const offWorkspace = subscribeIpc('workspace:changed', reload, 'github')
    const offHead = subscribeIpc('github:headChanged', reload, 'github')
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', reload)
      offWorkspace()
      offHead()
    }
  }, [load])

  if (!status?.isGit) return null

  const { repo, branch, shortOid, changes, ahead, behind, hasUpstream } = status
  const isGitLab = repo?.forge === 'gitlab'
  const Mark = isGitLab ? GitLabMark : GitHubMark
  const branchLabel = branch ?? t('github.footer.detachedHead', { oid: shortOid ?? '?' })
  const details = [
    repo ? `${repo.owner}/${repo.repo}` : t('github.footer.notGitHubTitle'),
    branchLabel,
    changes > 0 ? t('github.footer.changes', { count: changes }) : '',
    ahead > 0 || behind > 0 ? t('github.footer.aheadBehind', { ahead, behind }) : ''
  ].filter(Boolean).join('\n')
  const openUrl = (url: string) => {
    setOpen(false)
    void window.ade.invoke('github:open', url).catch(() => {}) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  }

  return <>
    <button
      ref={anchor}
      type="button"
      className="statusbar__btn gh-status"
      aria-label={t('github.footer.label')}
      aria-haspopup="menu"
      aria-expanded={open}
      title={details}
      disabled={!repo}
      onClick={() => setOpen((v) => !v)}
      data-testid="statusbar-github"
    >
      {repo ? <Mark /> : <GitBranch size={12} strokeWidth={2} aria-hidden="true" />}
      {repo ? <span className="statusbar__value gh-status__repo">{repo.owner}/{repo.repo}</span>
        : <span className="statusbar__value gh-status__muted">{t('github.footer.notGitHub')}</span>}
      <span className="gh-status__sep" aria-hidden="true">·</span>
      <span className="statusbar__value gh-status__branch">{branchLabel}</span>
      {changes > 0 && <span className="gh-status__badge" aria-hidden="true">•{changes}</span>}
      {ahead > 0 && <span className="gh-status__badge" aria-hidden="true"><ArrowUp size={10} strokeWidth={2} />{ahead}</span>}
      {behind > 0 && <span className="gh-status__badge" aria-hidden="true"><ArrowDown size={10} strokeWidth={2} />{behind}</span>}
    </button>
    {open && repo && <StatusPopover anchor={anchor.current} label={t('github.footer.label')} onClose={() => setOpen(false)}>
      <div className="gh-menu" role="menu">
        <button type="button" role="menuitem" className="gh-menu__item" onClick={() => openUrl(repo.webUrl)}>
          <Mark /><span>{t(isGitLab ? 'gitlab.footer.openRepo' : 'github.footer.openRepo')}</span><ExternalLink size={12} aria-hidden="true" />
        </button>
        <button type="button" role="menuitem" className="gh-menu__item" disabled={!branch || !hasUpstream}
          title={branch && !hasUpstream ? t(isGitLab ? 'gitlab.footer.branchNotPushed' : 'github.footer.branchNotPushed') : undefined}
          onClick={() => branch && openUrl(branchWebUrl(repo, branch))}>
          <GitBranch size={12} aria-hidden="true" /><span>{t(isGitLab ? 'gitlab.footer.openBranch' : 'github.footer.openBranch')}</span><ExternalLink size={12} aria-hidden="true" />
        </button>
        {branch && !hasUpstream && <p className="gh-menu__note">{t(isGitLab ? 'gitlab.footer.branchNotPushed' : 'github.footer.branchNotPushed')}</p>}
      </div>
    </StatusPopover>}
    <span className="statusbar__divider" aria-hidden="true" />
  </>
}
