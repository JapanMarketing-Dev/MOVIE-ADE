import type { GitHubAccount, GitHubRepoRef } from '@shared/github'
import { forgeForHost, isSafeGitLabPath, isSafeHost } from '@shared/forge'

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

/**
 * `git remote get-url origin` の値から、ホストとリポジトリのパス（先頭・末尾の / と .git を外したもの）を求める。
 * https・ssh://・scp 形式（git@host:path）に対応する。
 *
 * Orca由来: ~/bench/orca/src/main/github/github-remote-identity-parsing.ts の parseGitHubRemoteIdentity（MIT）
 */
function parseRemoteLocation(remoteUrl: string): { host: string; path: string } | null {
  const trimmed = remoteUrl.trim()
  const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/i)
  // scp 形式は「://」を含まない。C:\ のような Windows のパスも弾く
  if (scp && !trimmed.includes('://') && scp[1]!.length > 1) {
    return { host: normalizeHost(scp[1]!), path: cleanPath(scp[2]!) }
  }
  try {
    const url = new URL(trimmed)
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) return null
    return { host: normalizeHost(hostFromUrl(url)), path: cleanPath(decodeURIComponent(url.pathname)) }
  } catch {
    return null
  }
}

function cleanPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
}

/** GitHub の owner/repo（ちょうど2つの区切り）として読む */
export function parseGitRemote(remoteUrl: string): GitHubRepoRef | null {
  const loc = parseRemoteLocation(remoteUrl)
  if (!loc) return null
  const parts = loc.path.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(loc.path)) return null
  return toRef(loc.host, parts[0], parts[1])
}

/**
 * GitHub か GitLab かを決めて読む。GitLab はサブグループ（group/sub/project）を許し、owner に group/sub を入れる。
 * gitlabHosts は glab にログイン済みのホスト（セルフホストの GitLab を見分けるため）
 */
export function parseForgeRemote(remoteUrl: string, gitlabHosts: readonly string[] = []): GitHubRepoRef | null {
  const loc = parseRemoteLocation(remoteUrl)
  if (!loc || !isSafeHost(loc.host)) return null
  if (forgeForHost(loc.host, gitlabHosts) === 'github') return parseGitRemote(remoteUrl)
  if (!isSafeGitLabPath(loc.path)) return null
  const at = loc.path.lastIndexOf('/')
  return { ...toRef(loc.host, loc.path.slice(0, at), loc.path.slice(at + 1)), forge: 'gitlab' }
}

/** ホストに使っている CLI で判定が要るか（github.com / gitlab.com などで決まらないホスト） */
export function needsHostLookup(remoteUrl: string): string | null {
  const loc = parseRemoteLocation(remoteUrl)
  if (!loc) return null
  const h = loc.host.toLowerCase()
  if (forgeForHost(h) === 'gitlab' || h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.ghe.com')) return null
  return loc.host
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

// ─── git status --porcelain=v2 --branch ─────────────────

interface GitStatusSummary {
  branch: string | null
  shortOid: string | null
  changes: number
  ahead: number
  behind: number
  hasUpstream: boolean
}

/**
 * `git status --porcelain=v2 --branch` を読む。見出し行（# branch.*）からブランチと ahead/behind、
 * 残りの行から変更のあるファイル数を数える。
 *
 * Orca由来: ~/bench/orca/src/shared/git-status-porcelain-parser.ts の branch.oid / branch.head / branch.ab の読み方（MIT）
 */
export function parseGitStatus(text: string): GitStatusSummary {
  const summary: GitStatusSummary = { branch: null, shortOid: null, changes: 0, ahead: 0, behind: 0, hasUpstream: false }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      // コミットが1つも無いリポジトリは (initial)
      summary.shortOid = /^[0-9a-f]{7,}$/i.test(oid) ? oid.slice(0, 7) : null
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      summary.branch = head && head !== '(detached)' ? head : null
    } else if (line.startsWith('# branch.upstream ')) {
      summary.hasUpstream = true
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        summary.ahead = Number(match[1])
        summary.behind = Number(match[2])
      }
    } else if (/^[12u?] /.test(line)) {
      // 1: 変更 2: 名前の変更・コピー u: 競合 ?: 追跡外
      summary.changes++
    }
  }
  return summary
}
