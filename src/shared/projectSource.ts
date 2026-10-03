import { checkSshTarget, type SshTarget } from './sshCommand'
import { isSafeHost } from './forge'

/**
 * プロジェクトをどこから開いたか（自分の PC / GitHub から取得 / SSH）と、その周りの純粋な関数。
 * 種類（web / mobile / desktop / other。src/shared/projectTargets.ts）とは別の軸。
 *
 * Orca由来（MIT）: ~/bench/orca/src/shared/git-clone-failure-message.ts,
 *   ~/bench/orca/src/shared/git-remote-error.ts（stripCredentialsFromMessage）,
 *   ~/bench/orca/src/main/git/repo-clone-path.ts（deriveCloneRepoNameFromUrl）,
 *   ~/bench/orca/src/main/ipc/repos/repo-clone-lifecycle.ts（emitCloneProgressFromText）,
 *   ~/bench/orca/src/main/ssh/ssh-config-parser.ts（parseSshConfig）。
 * Orca の SSH 中継・リモートのファイル操作・worktree は持ち込まない。
 */

export type ProjectSource = 'local' | 'github' | 'ssh'

/** ホームの下のパスを ~/… で見せる（画面に Mac のユーザー名を出さない・短くする） */
export function tildePath(path: string, home: string): string {
  const h = home.replace(/[\\/]+$/, '')
  if (!h) return path
  if (path === h) return '~'
  return path.startsWith(`${h}/`) || path.startsWith(`${h}\\`) ? `~${path.slice(h.length)}` : path
}
export const PROJECT_SOURCES: readonly ProjectSource[] = ['local', 'github', 'ssh']

// Orca由来: git-remote-error.ts の USERPASS_URL_PATTERN / HTTPS_TOKEN_URL_PATTERN（MIT）
const USERPASS_URL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
const HTTPS_TOKEN_URL_PATTERN = /(https?:\/\/)[^\s/@:]+@/gi

/** URL やメッセージから user:password@ と https のトークン（user@）を落とす。git@host の user は残す */
export function stripUrlCredentials(text: string): string {
  return text.replace(USERPASS_URL_PATTERN, '$1').replace(HTTPS_TOKEN_URL_PATTERN, '$1')
}

/** 設定ファイルの値を整える。ssh が欠けた ssh は local に戻す */
export function sanitizeProjectSource(raw: { source?: unknown; ssh?: unknown; remoteUrl?: unknown }): {
  source: ProjectSource
  ssh?: SshTarget
  remoteUrl?: string
} {
  const source = PROJECT_SOURCES.includes(raw.source as ProjectSource) ? (raw.source as ProjectSource) : 'local'
  if (source === 'ssh') {
    const r = (raw.ssh && typeof raw.ssh === 'object' ? raw.ssh : {}) as Partial<SshTarget>
    const checked = checkSshTarget({ host: typeof r.host === 'string' ? r.host : '', path: typeof r.path === 'string' ? r.path : '' })
    return checked.ok ? { source, ssh: checked.target } : { source: 'local' }
  }
  if (source === 'github') {
    const url = typeof raw.remoteUrl === 'string' ? stripUrlCredentials(raw.remoteUrl.trim()).slice(0, 2000) : ''
    // 設定のスキーマ（settingsSchema.ts の remoteUrl）に合う形だけ残す。file:// などは保存しない
    return /^(https?:\/\/|git@|ssh:\/\/)/.test(url) ? { source, remoteUrl: url } : { source }
  }
  return { source }
}

export type CloneUrlCheck = { ok: true; url: string } | { ok: false }

/**
 * 入力を git clone できる URL にする。
 *   owner/repo（GitHub の短い形）→ https://github.com/owner/repo.git
 *   https:// / ssh:// / git@host:group/sub/repo / file://（手元の bare リポジトリ）は形を確かめてそのまま
 * トークン入りの URL（https://user:token@…）は受け付けない（保存や表示に漏れるため。gh auth setup-git などを使ってもらう）。
 * git の引数に入るので厳密に見る: 制御文字・空白・- で始まる値・ホスト名でないホスト・?や#・.. の区切りは断る。
 */
export function normalizeCloneUrl(input: string): CloneUrlCheck {
  const value = input.trim()
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(value) || value.startsWith('-')) return { ok: false }
  if (stripUrlCredentials(value) !== value) return { ok: false }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith('.') && !value.includes('..')) {
    return { ok: true, url: `https://github.com/${value.replace(/\.git$/, '')}.git` }
  }
  if (/^(https?|ssh|git|file):\/\//i.test(value)) {
    let url: URL
    try { url = new URL(value) } catch { return { ok: false } }
    if (url.search || url.hash || value.includes('?') || value.includes('#')) return { ok: false }
    if (url.protocol === 'file:') return url.host === '' && url.pathname.length > 1 ? { ok: true, url: value } : { ok: false }
    if (!isSafeHost(url.host) || url.pathname.replace(/\/+$/, '') === '') return { ok: false }
    if (/(^|\/)\.\.?(\/|$)/.test(value.slice(value.indexOf('//') + 2))) return { ok: false }
    return { ok: true, url: value }
  }
  const scp = value.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)@([^:/@]+):([A-Za-z0-9_~][A-Za-z0-9_.~/-]*)$/)
  if (scp && isSafeHost(scp[2]!) && !/(^|\/)\.\.?(\/|$)/.test(scp[3]!) && !scp[3]!.includes('//')) return { ok: true, url: value }
  return { ok: false }
}

/**
 * clone 先のフォルダ名（git clone の既定と同じく URL の最後の部分。.git は外す）。
 * Orca由来: repo-clone-path.ts の deriveCloneRepoNameFromUrl（MIT）。. や .. になるものは受け付けない。
 */
export function cloneRepoName(url: string): string | null {
  const source = url.replace(/\/+$/, '').replace(/\.git$/, '')
  const name = source.split(/[/:\\]/).pop() ?? ''
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return null
  return name
}

/**
 * git clone --progress の stderr から進み具合を読む（最後に出た行）。
 * Orca由来: repo-clone-lifecycle.ts の emitCloneProgressFromText（MIT）。
 */
export function parseCloneProgress(text: string): { phase: string; percent: number } | null {
  let last: { phase: string; percent: number } | null = null
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.match(/^(?:remote:\s*)?([A-Za-z][\w\s]*?):\s+(\d+)%/)
    if (match) last = { phase: match[1]!.trim(), percent: Math.min(100, Number.parseInt(match[2]!, 10)) }
  }
  return last
}

export type CloneFailureKind = 'exists' | 'auth' | 'not-found' | 'network' | 'cancelled' | 'failed'

/**
 * clone の失敗を、利用者に伝える種類と1行に分ける（1行は資格情報を落とした git の fatal: / error: の行）。
 * Orca由来: git-clone-failure-message.ts の getGitCloneFailureMessage（MIT）の考え方
 *   - 下の行から見て、最初の fatal: / error: の行を使う
 *   - 「既にある」は別の言い方にする
 *   - BatchMode で動かすので、鍵のパスフレーズや未登録のホスト鍵は ssh-agent / known_hosts に任せる旨を添える
 */
export function cloneFailure(stderr: string): { kind: CloneFailureKind; detail: string } {
  const scrubbed = stripUrlCredentials(stderr).replace(/\u001b\[[0-9;]*m/g, '')
  const lines = scrubbed.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
  let detail = lines.at(-1) ?? ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const at = Math.max(line.indexOf('fatal:'), line.indexOf('error:'))
    if (at !== -1) { detail = line.slice(at); break }
  }
  const all = scrubbed.toLowerCase()
  let kind: CloneFailureKind = 'failed'
  if (/already exists and is not an empty directory|destination path .* already exists/.test(all)) kind = 'exists'
  else if (/repository not found|not found|does not appear to be a git repository|does not exist/.test(all)) kind = 'not-found'
  else if (/authentication failed|could not read username|terminal prompts disabled|permission denied \(|host key verification failed|403/.test(all)) kind = 'auth'
  else if (/could not resolve host|connection timed out|connection refused|network is unreachable|unable to access/.test(all)) kind = 'network'
  return { kind, detail: detail.slice(0, 300) }
}

export interface SshConfigHost {
  host: string
  hostname?: string
  user?: string
}

/**
 * ~/.ssh/config の Host の一覧（ワイルドカードや否定のパターンは除く）。HostName と User は表示用に読む。
 * Orca由来: ssh-config-parser.ts の parseSshConfig（MIT）を、一覧に要る項目だけに縮めた。Include は読まない。
 */
export function parseSshConfigHosts(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let current: SshConfigHost[] = []
  const unquote = (v: string) => v.replace(/^"(.*)"$/, '$1')
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\s#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim()
    if (key === 'host') {
      const patterns = value.split(/\s+/).map(unquote).filter((p) => p && !p.startsWith('!') && !/[*?]/.test(p))
      current = patterns.map((host) => ({ host }))
      for (const h of current) if (!hosts.some((x) => x.host === h.host)) hosts.push(h)
      current = current.map((h) => hosts.find((x) => x.host === h.host)!)
      continue
    }
    if (key === 'match') { current = []; continue }
    if (key === 'hostname') for (const h of current) h.hostname ??= unquote(value)
    if (key === 'user') for (const h of current) h.user ??= unquote(value)
  }
  return hosts
}

/** 「GitHub / GitLab から取得」の一覧の1件（gh repo list・GitLab の projects API の項目） */
export interface GitHubRepoItem {
  /** GitLab ではサブグループを含む（group/sub/project） */
  nameWithOwner: string
  url: string
  sshUrl?: string
  isPrivate: boolean
  updatedAt?: string
  /** GitLab のとき、どのホストのプロジェクトか（gitlab.com・セルフホスト） */
  host?: string
}

export interface GitHubRepoList {
  /** CLI（GitHub は gh、GitLab は glab）が見つかったか */
  ghInstalled: boolean
  loggedIn: boolean
  repos: GitHubRepoItem[]
  /** 取れなかった理由（利用者向けの1行。トークンは含まない） */
  error?: string
}

/** gh repo list --json の出力を一覧にする（壊れた項目は捨てる） */
export function mapGitHubRepos(json: unknown): GitHubRepoItem[] {
  if (!Array.isArray(json)) return []
  return json.flatMap((item): GitHubRepoItem[] => {
    if (!item || typeof item !== 'object') return []
    const r = item as Record<string, unknown>
    if (typeof r.nameWithOwner !== 'string' || typeof r.url !== 'string') return []
    return [{
      nameWithOwner: r.nameWithOwner,
      url: r.url,
      ...(typeof r.sshUrl === 'string' ? { sshUrl: r.sshUrl } : {}),
      isPrivate: r.isPrivate === true,
      ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {})
    }]
  })
}

export interface CloneProgress {
  phase: string
  percent: number
}

/**
 * SSH のプロジェクトで Agent に送る本文。リモートの Agent からはローカルの feedback.md を読めないので、中身をそのまま貼る。
 * intro は「以下のフィードバックに対応して…画像はこの環境からは開けない」といった前置き（言語ごとの文）。
 * 長すぎる本文はターミナルへの貼り付けで詰まるので、上限で切り、切ったことを書き添える。
 */
export const MAX_REMOTE_FEEDBACK_CHARS = 60_000

export function buildRemoteFeedbackPrompt(intro: string, markdown: string, truncatedNote: string): string {
  const body = markdown.trim()
  const cut = body.length > MAX_REMOTE_FEEDBACK_CHARS ? `${body.slice(0, MAX_REMOTE_FEEDBACK_CHARS)}\n\n${truncatedNote}` : body
  return `${intro.trim()}\n\n${cut}\n`
}
