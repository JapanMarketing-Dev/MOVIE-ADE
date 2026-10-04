import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AccountAgent } from '@shared/types'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { isWithin } from '../sessions/containment'

/**
 * アカウントごとの設定フォルダの置き場所と、本システムの物であることの確認。
 *
 * Orca由来: ~/bench/orca/src/main/codex-accounts/codex-managed-home-path.ts,
 *           ~/bench/orca/src/main/codex-accounts/host-codex-managed-home-ownership.ts,
 *           ~/bench/orca/src/main/claude-accounts/managed-auth-path.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく、フォルダに所有の印（マーカーファイル）を置き、使う前と消す前に
 *   - 置き場所の中にあること（シンボリックリンクで外へ逃げていないこと）
 *   - ~/.codex・~/.claude の中を指していないこと
 *   - 印の中身がアカウントの id と一致すること
 * を確かめる。WSL・Windows のパス表記・一時的な読み取り失敗の区別は持ち込んでいない。
 */

export const MANAGED_ACCOUNT_MARKER = '.ade-managed-account'

/** id は randomUUID のみ受け付ける（パスの一部になるため） */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id)
}

/** <userData>/accounts/<agent> */
export function accountsRootFor(userDataDir: string, agent: AccountAgent): string {
  return join(userDataDir, 'accounts', agent)
}

/** <userData>/accounts/<agent>/<id>。これがそのまま CODEX_HOME / CLAUDE_CONFIG_DIR になる */
export function managedAccountDir(userDataDir: string, agent: AccountAgent, accountId: string): string {
  if (!isValidAccountId(accountId)) throw new UserFacingError(t('accounts.errors.invalidId'))
  return join(accountsRootFor(userDataDir, agent), accountId)
}

/** システムの既定アカウントの設定フォルダ。環境変数で場所を変えていればそれに従う */
export function systemConfigDir(agent: AccountAgent, env: NodeJS.ProcessEnv = process.env): string {
  if (agent === 'codex') return env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

function realpathIfPresent(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // まだ無いパス（想定内）
    return resolve(path)
  }
}

type ManagedDirVerdict = { kind: 'owned'; dir: string } | { kind: 'untrusted'; reason: string }

/** 設定フォルダが本システムの物かを調べる（投げない版）。理由は利用者向けの文 */
export function verifyManagedAccountDir(options: {
  userDataDir: string
  agent: AccountAgent
  accountId: string
  systemDir?: string
}): ManagedDirVerdict {
  const { userDataDir, agent, accountId } = options
  if (!isValidAccountId(accountId)) return { kind: 'untrusted', reason: t('accounts.errors.invalidId') }
  const expected = managedAccountDir(userDataDir, agent, accountId)
  let canonical: string
  let canonicalRoot: string
  try {
    if (!statSync(expected).isDirectory()) return { kind: 'untrusted', reason: t('accounts.errors.notDirectory') }
    canonical = realpathSync(expected)
    canonicalRoot = realpathSync(accountsRootFor(userDataDir, agent))
  } catch {
    return { kind: 'untrusted', reason: t('accounts.errors.folderMissing') }
  }
  // 置き場所のフォルダが差し替えられて、本物の ~/.codex・~/.claude を指していないこと（Orca と同じ確認）
  const systemDir = realpathIfPresent(options.systemDir ?? systemConfigDir(agent))
  if (isWithin(systemDir, canonical) || isWithin(canonical, systemDir)) {
    return { kind: 'untrusted', reason: t('accounts.errors.pointsToDefault') }
  }
  if (canonical !== join(canonicalRoot, accountId)) {
    return { kind: 'untrusted', reason: t('accounts.errors.outsideStore') }
  }
  const markerPath = join(canonical, MANAGED_ACCOUNT_MARKER)
  try {
    if (!lstatSync(markerPath).isFile()) return { kind: 'untrusted', reason: t('accounts.errors.markerBroken') }
    if (readFileSync(markerPath, 'utf8').trim() !== accountId) {
      return { kind: 'untrusted', reason: t('accounts.errors.markerMismatch') }
    }
  } catch {
    return { kind: 'untrusted', reason: t('accounts.errors.markerMissing') }
  }
  return { kind: 'owned', dir: canonical }
}

/** 使う前の確認（投げる版） */
export function assertManagedAccountDir(options: Parameters<typeof verifyManagedAccountDir>[0]): string {
  const verdict = verifyManagedAccountDir(options)
  if (verdict.kind === 'owned') return verdict.dir
  throw new Error(verdict.reason)
}

/** 新しい設定フォルダを作って印を置く。既にあるフォルダは使わない（他人のフォルダへ書かないため） */
export function createManagedAccountDir(userDataDir: string, agent: AccountAgent, accountId: string): string {
  const root = accountsRootFor(userDataDir, agent)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = managedAccountDir(userDataDir, agent, accountId)
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, MANAGED_ACCOUNT_MARKER), `${accountId}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return assertManagedAccountDir({ userDataDir, agent, accountId })
}

/**
 * 設定フォルダを消す。本システムの物だと確かめられたときだけ消す。
 * 確かめられなければ何も消さず false を返す（Orca の safeRemove と同じ考え方）。
 */
export function removeManagedAccountDir(userDataDir: string, agent: AccountAgent, accountId: string): boolean {
  const verdict = verifyManagedAccountDir({ userDataDir, agent, accountId })
  if (verdict.kind !== 'owned') return false
  rmSync(verdict.dir, { recursive: true, force: true })
  return true
}
