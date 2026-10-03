/**
 * GitHub と GitLab（gitlab.com とセルフホスト）のどちらかを見分ける、main と renderer で共有する純粋な関数。
 *
 * 認証はそれぞれの CLI（gh / glab）に任せる。本システムはトークンを読まず、保存もしない。
 * ホスト名は glab の --hostname や、内蔵ターミナルへ送るログインのコマンドに入るので、形を厳密に確かめる。
 */

import { cliLoginCommand as catalogLogin } from './cliTools'

export type Forge = 'github' | 'gitlab'
export type ForgeCli = 'gh' | 'glab'

export const GITLAB_COM = 'gitlab.com'

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** ホスト名（ポート付き可）。英数字・-・. だけで、各ラベルは - で始まらず終わらない。空白・引用符・; などは通さない */
export function isSafeHost(host: unknown): host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > 260) return false
  const m = host.match(/^([^:]+)(?::(\d{1,5}))?$/)
  if (!m) return false
  const port = m[2] === undefined ? null : Number(m[2])
  if (port !== null && (port < 1 || port > 65535)) return false
  const name = m[1]!
  return name.length <= 253 && name.split('.').every((label) => LABEL.test(label))
}

/** ポートを外し、小文字にする（gh / glab の設定はポート無しのホスト名で持つことが多い） */
function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '')
}

/**
 * リモートのホストから、GitHub か GitLab かを決める。
 *   - glab にログイン済みのホスト（セルフホストの GitLab）・gitlab.com・「gitlab」で始まるラベルを含むホスト → GitLab
 *   - それ以外 → GitHub（github.com と GitHub Enterprise。今までの扱いのまま）
 */
export function forgeForHost(host: string, gitlabHosts: readonly string[] = []): Forge {
  const h = bareHost(host)
  if (!h) return 'github'
  if (gitlabHosts.some((g) => bareHost(g) === h)) return 'gitlab'
  if (h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.ghe.com')) return 'github'
  if (h === GITLAB_COM || h.split('.').some((label) => label.startsWith('gitlab'))) return 'gitlab'
  return 'github'
}

/** 画面に出す名前（固有名なので訳さない） */
export function forgeLabel(forge: Forge): string {
  return forge === 'gitlab' ? 'GitLab' : 'GitHub'
}

/**
 * GitLab のプロジェクトのパス（group/subgroup/project）の1区切り。
 * GitLab の決まり（英数字・_・-・.、記号で始まらない）より少し狭くし、-で始まるもの（オプションに読まれる）を通さない
 */
const GITLAB_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/

export function isSafeGitLabPath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  const parts = path.split('/')
  return parts.length >= 2 && parts.length <= 20 && parts.every((p) => GITLAB_SEGMENT.test(p) && !p.endsWith('.git') && !p.endsWith('.atom') && p !== '.' && p !== '..')
}

/** ブランチのページ。GitLab は /-/tree/、GitHub は /tree/。ブランチ名の「/」は区切りのまま残す */
export function forgeBranchUrl(webUrl: string, forge: Forge, branch: string): string {
  const path = branch.split('/').map(encodeURIComponent).join('/')
  return forge === 'gitlab' ? `${webUrl}/-/tree/${path}` : `${webUrl}/tree/${path}`
}

// ─── CLI のログイン ────────────────────────────
// インストールのコマンド・公式ページ・既定のログインは CLI の一覧（cli-setup の src/shared/cliTools.ts）が正本。
// ここはホスト付きのログイン・ログアウトだけを足す（セルフホストの GitLab・GitHub Enterprise のため）。

/**
 * ログインのコマンド。ホストは isSafeHost を通ったものだけを入れる（ターミナルのシェルに渡る1行なので、
 * ; や $() などを含む値は混ぜない）。既定のホスト（github.com / gitlab.com）・通らない値は一覧の既定のコマンド
 */
export function cliLoginCommand(cli: ForgeCli, host?: string): string {
  const fallback = catalogLogin(cli) ?? (cli === 'gh' ? 'gh auth login --web -h github.com' : 'glab auth login')
  if (!isSafeHost(host)) return fallback
  if (cli === 'gh') return host === 'github.com' ? fallback : `gh auth login --web -h ${host}`
  return host === GITLAB_COM ? fallback : `glab auth login --hostname ${host}`
}

export function cliLogoutCommand(cli: ForgeCli, host: string): string | null {
  if (!isSafeHost(host)) return null
  return cli === 'gh' ? `gh auth logout -h ${host}` : `glab auth logout --hostname ${host}`
}

// ─── GitLab の接続状態 ───────────────────────────

/** `glab auth status` の1ホスト分。トークンは入れない */
export interface GitLabAccount {
  host: string
  /** ログインできていなければ null */
  user: string | null
}

export interface GitLabStatus {
  glabInstalled: boolean
  /** ログイン済みのホスト（user が入っているもの）を先に並べる */
  accounts: GitLabAccount[]
  /** GITLAB_TOKEN などの環境変数が入っていて、glab がそれを使う */
  envToken: 'GITLAB_TOKEN' | 'GITLAB_ACCESS_TOKEN' | 'OAUTH_TOKEN' | null
  /** glab が無いときに内蔵ターミナルへ送れるコマンド（Linux は null） */
  installCommand: string | null
  /** 今のプロジェクトの origin がセルフホストの GitLab なら、そのホスト（ログインのボタンに使う） */
  projectHost: string | null
  error: string | null
}
