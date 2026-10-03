import type { GitHubAccount, GitHubPullRequest, GitHubRepoRef } from '@shared/github'
import { SUPPORTED_LOCALES, t, translate, type MessageKey } from '@shared/i18n'

/**
 * gh・git の出力を読む純粋な関数。electron も子プロセスも使わないので、単体テストから直接呼べる。
 */

// ─── git remote → owner/repo ───────────────────────────

/** ssh.github.com は github.com の SSH-over-HTTPS（GitHub の公式の別名） */
function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.$/, '')
  return lower === 'ssh.github.com' ? 'github.com' : lower
}

/** http(s) のポートは GHES の入口を表すので残す。ssh / git のポートは通信路だけの話なので捨てる */
function hostFromUrl(url: URL): string {
  const protocol = url.protocol.toLowerCase()
  return protocol === 'http:' || protocol === 'https:' ? url.host : url.hostname
}

function ownerRepoFromPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) return null
  const [owner, withSuffix] = parts as [string, string]
  const repo = withSuffix.replace(/\.git$/i, '')
  return owner && repo ? { owner, repo } : null
}

/**
 * `git remote get-url origin` の値から host / owner / repo を求める。
 * https・ssh://・scp 形式（git@host:owner/repo）と、末尾の .git の有無に対応する。
 *
 * Orca由来: ~/bench/orca/src/main/github/github-remote-identity-parsing.ts の parseGitHubRemoteIdentity（MIT）
 */
export function parseGitRemote(remoteUrl: string): GitHubRepoRef | null {
  const trimmed = remoteUrl.trim()
  const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  // scp 形式は「://」を含まない。C:\ のような Windows のパスも弾く
  if (scp && !trimmed.includes('://') && scp[1]!.length > 1) {
    return toRef(normalizeHost(scp[1]!), scp[2]!, scp[3]!)
  }
  try {
    const url = new URL(trimmed)
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) return null
    const path = ownerRepoFromPath(url.pathname)
    return path ? toRef(normalizeHost(hostFromUrl(url)), path.owner, path.repo) : null
  } catch {
    return null
  }
}

function toRef(host: string, owner: string, repo: string): GitHubRepoRef {
  return { host, owner, repo, webUrl: `https://${host}/${owner}/${repo}` }
}

// ─── gh auth status ───────────────────────────────────

/**
 * `gh auth status` の出力（stderr / stdout のどちらにも出る）を読む。ホストごとに次の形:
 *
 *   github.com
 *     ✓ Logged in to github.com account NAME (keyring)
 *     - Active account: true
 *     - Token: gho_************
 *     - Token scopes: 'gist', 'read:org', 'repo'
 *
 * 「Token:」の行（伏せ字のトークン）は読まない。結果にトークンは入らない。
 *
 * Orca由来: ~/bench/orca/src/main/github/auth-diagnose.ts の parseAuthStatus（MIT）
 */
export function parseAuthStatus(text: string): GitHubAccount[] {
  const accounts: GitHubAccount[] = []
  let currentHost: string | null = null
  let current: GitHubAccount | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    // ホストの見出し：字下げなしのホスト名だけの行（末尾にコロンを付ける版もある）
    const hostMatch = line.match(/^([a-z0-9][a-z0-9.-]*(?::\d+)?)\s*:?\s*$/i)
    if (hostMatch && !/^logged\b/i.test(line)) {
      currentHost = hostMatch[1]!
      continue
    }
    const loggedIn = line.match(/Logged in to (\S+) account (\S+)(?:\s+\(([^)]+)\))?/i)
    if (loggedIn) {
      if (current) accounts.push(current)
      const label = (loggedIn[3] ?? '').trim()
      current = {
        host: loggedIn[1] || currentHost || 'github.com',
        user: loggedIn[2]!,
        active: false,
        // keyring 以外に (GITHUB_TOKEN) / (GH_TOKEN) が出たら、環境変数のトークンがキーリングを覆っている
        source: label === 'GITHUB_TOKEN' || label === 'GH_TOKEN' ? 'env' : 'keyring',
        scopes: []
      }
      continue
    }
    if (!current) continue
    const active = line.match(/Active account:\s*(true|false)/i)
    if (active) {
      current.active = active[1]!.toLowerCase() === 'true'
      continue
    }
    const scopes = line.match(/Token scopes:\s*(.+)$/i)
    if (scopes) {
      current.scopes = scopes[1]!.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    }
  }
  if (current) accounts.push(current)
  // 古い gh は「Active account」を出さない。1つしか無ければそれを使っているとみなす
  if (accounts.length === 1 && !text.match(/Active account:/i)) accounts[0]!.active = true
  return accounts
}

/** 指定ホスト（無ければどれでも）の今使われているアカウント */
export function pickActiveAccount(accounts: GitHubAccount[], host?: string): GitHubAccount | null {
  const pool = host ? accounts.filter((a) => a.host.toLowerCase() === host.toLowerCase()) : accounts
  return pool.find((a) => a.active) ?? pool[0] ?? null
}

// ─── gh pr list --json ───────────────────

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

export function mapPullRequests(json: unknown): GitHubPullRequest[] {
  if (!Array.isArray(json)) return []
  return json.flatMap((raw) => {
    const r = asRecord(raw)
    if (!r || typeof r.number !== 'number') return []
    const state = asString(r.state).toUpperCase()
    return [{
      number: r.number,
      title: asString(r.title),
      state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
      isDraft: r.isDraft === true,
      url: asString(r.url),
      updatedAt: asString(r.updatedAt),
      headRefName: asString(r.headRefName)
    } satisfies GitHubPullRequest]
  })
}

// ─── feedback.md → Issue ─────────────────────────────

/** Issue のタイトルの上限（GitHub は 256 文字） */
const TITLE_MAX = 120

/**
 * feedback.md から Issue のタイトルと本文を作る。
 * - タイトル: 見出し（「UIフィードバック（N件）」）と対象のホスト
 * - 本文: feedback.md のまま。ただし画像（./01.png）は GitHub からは見えないので行ごと外し、末尾に断り書きを付ける
 */
export function issueFromFeedback(markdown: string): { title: string; body: string } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const heading = lines.find((l) => l.startsWith('# '))?.slice(2).trim() || t('github.issue.titleFallback')
  // feedback.md は書き出した時点の画面の言語なので、どの言語の見出しでも読めるようにする
  const targetLine = labelLine('feedbackMd.label.target')
  const imageLine = labelLine('feedbackMd.label.images')
  const target = lines.map((l) => l.match(targetLine)?.[1]).find(Boolean)
  let host = ''
  if (target) {
    try { host = new URL(target).host } catch { host = target }
  }
  const title = (host ? `${heading}: ${host}` : heading).slice(0, TITLE_MAX)
  const images = lines.filter((l) => imageLine.test(l)).length
  const body = lines.filter((l) => !imageLine.test(l)).join('\n').trim()
  const note = images > 0 ? `\n\n---\n${t('github.issue.imagesNote', { count: images })}` : ''
  return { title, body: `${body}${note}\n\n<sub>${t('github.issue.sentFrom')}</sub>` }
}

/** 「- 対象: 値」「- Target: 値」のような行。すべての言語の見出しを受け付ける */
function labelLine(key: MessageKey): RegExp {
  const labels = [...new Set(SUPPORTED_LOCALES.map((locale) => translate(locale, key)))]
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^- (?:${escaped.join('|')}):\\s*(\\S+)?`)
}
