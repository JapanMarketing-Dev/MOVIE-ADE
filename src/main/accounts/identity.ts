import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { t } from '@shared/i18n'

/**
 * 設定フォルダから「ログイン済みか」と「誰としてログインしているか」を読む。
 *
 * Orca由来: ~/bench/orca/src/main/codex-accounts/managed-codex-auth-readiness.ts（hasStoredCodexCredential）,
 *           ~/bench/orca/src/main/codex-accounts/codex-auth-identity.ts（readCodexAuthIdentity）,
 *           ~/bench/orca/src/main/claude-accounts/claude-auth-capture.ts（resolveClaudeIdentity）,
 *           ~/bench/orca/src/main/claude-accounts/keychain.ts（getActiveClaudeService）（MIT, Copyright 2026 Lovecast Inc.）
 *
 * トークンそのものは返さない・ログに出さない。取り出すのはメールアドレスとプラン名だけ。
 * Orca は Claude の認証情報を Keychain から取り出して差し替えるが、本システムは
 * CLAUDE_CONFIG_DIR ごとに Claude Code 自身が Keychain の項目を分けるのに任せ、項目が「あるか」だけを見る。
 */

export interface AccountIdentity {
  signedIn: boolean
  email: string | null
  workspaceLabel: string | null
}

const NONE: AccountIdentity = { signedIn: false, email: null, workspaceLabel: null }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

// ───────────────────────── Codex ─────────────────────────

/** JWT の本文だけを読む（署名は確かめない。表示用のメールを取り出すだけ） */
function parseJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    return asRecord(JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')))
  } catch {
    return null
  }
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Personal (Free)',
  go: 'Personal (Go)',
  plus: 'Personal (Plus)',
  pro: 'Personal (Pro)',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Education'
}

/** auth.json に使える認証情報があるか（Orca の hasCredentialForDeclaredMode を簡略化） */
export function hasCodexCredential(auth: Record<string, unknown> | null): boolean {
  if (!auth || Object.keys(auth).length === 0) return false
  if (readString(auth, 'OPENAI_API_KEY')) return true
  const tokens = asRecord(auth.tokens)
  if (readString(tokens, 'access_token') && readString(tokens, 'refresh_token')) return true
  if (readString(auth, 'personal_access_token')) return true
  if (auth.agent_identity) return true
  return readString(asRecord(auth.bedrock_api_key), 'api_key') !== null
}

/** CODEX_HOME（またはシステムの ~/.codex）の auth.json を読む */
export function readCodexIdentity(codexHome: string): AccountIdentity {
  const auth = readJsonFile(join(codexHome, 'auth.json'))
  if (!hasCodexCredential(auth)) return NONE
  const tokens = asRecord(auth?.tokens)
  const idToken = readString(tokens, 'id_token')
  const payload = idToken ? parseJwtPayload(idToken) : null
  const authClaims = asRecord(payload?.['https://api.openai.com/auth'])
  const profileClaims = asRecord(payload?.['https://api.openai.com/profile'])
  const plan = readString(authClaims, 'chatgpt_plan_type')?.toLowerCase()
  return {
    signedIn: true,
    email: readString(payload, 'email') ?? readString(profileClaims, 'email'),
    workspaceLabel:
      readString(authClaims, 'workspace_name') ??
      readString(profileClaims, 'workspace_name') ??
      (plan ? (PLAN_LABEL[plan] ?? null) : readString(auth, 'OPENAI_API_KEY') ? t('accounts.plan.apiKey') : null)
  }
}

// ───────────────────────── Claude ─────────────────────────

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * Claude Code 2.1 以降は CLAUDE_CONFIG_DIR ごとに Keychain の項目名を分ける
 * （sha256(NFC(dir)) の先頭8文字を付ける）。Orca の getActiveClaudeService と同じ。
 */
export function claudeKeychainService(configDir?: string): string {
  if (!configDir) return CLAUDE_KEYCHAIN_SERVICE
  const suffix = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`
}

/** Claude Code が Keychain の利用者名に使う値（Orca の getKeychainUser と同じ） */
function claudeKeychainUser(): string {
  try {
    const user = process.env.USER || process.env.USERNAME || userInfo().username
    return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
  } catch {
    return 'claude-code-user'
  }
}

const execFileAsync = promisify(execFile)

/**
 * macOS の Keychain に項目が「あるか」だけを調べる。-w を付けないので中身は読まない。
 * 見つからなければ security は 44 で終わる。
 */
async function keychainItemExists(service: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await execFileAsync('security', ['find-generic-password', '-s', service, '-a', claudeKeychainUser()], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** .claude.json（または .config.json）の oauthAccount。トークンは入っていない */
function readClaudeOauthAccount(configPaths: string[]): Record<string, unknown> | null {
  for (const path of configPaths) {
    const oauth = asRecord(readJsonFile(path)?.oauthAccount)
    if (oauth) return oauth
  }
  return null
}

function claudeIdentityFrom(oauth: Record<string, unknown> | null, signedIn: boolean): AccountIdentity {
  if (!signedIn) return NONE
  return {
    signedIn,
    email: readString(oauth, 'emailAddress') ?? readString(oauth, 'email'),
    workspaceLabel: readString(oauth, 'organizationName')
  }
}

/** 管理アカウントの CLAUDE_CONFIG_DIR を読む */
export async function readClaudeIdentity(configDir: string): Promise<AccountIdentity> {
  const oauth = readClaudeOauthAccount([join(configDir, '.claude.json'), join(configDir, '.config.json')])
  // Linux / Windows はファイル、macOS は Keychain に認証情報を置く
  const signedIn =
    existsSync(join(configDir, '.credentials.json')) ||
    (oauth !== null && (process.platform !== 'darwin' || (await keychainItemExists(claudeKeychainService(configDir)))))
  return claudeIdentityFrom(oauth, signedIn)
}

/**
 * システムの既定アカウント（読むだけ）。CLAUDE_CONFIG_DIR が無ければ設定は ~/.claude.json、
 * 認証情報は ~/.claude/.credentials.json か Keychain の無印の項目にある。
 */
export async function readClaudeSystemIdentity(env: NodeJS.ProcessEnv = process.env): Promise<AccountIdentity> {
  const inherited = env.CLAUDE_CONFIG_DIR?.trim()
  if (inherited) return readClaudeIdentity(inherited)
  const configDir = join(homedir(), '.claude')
  const oauth = readClaudeOauthAccount([join(configDir, '.claude.json'), join(homedir(), '.claude.json')])
  const signedIn =
    existsSync(join(configDir, '.credentials.json')) ||
    (oauth !== null && (process.platform !== 'darwin' || (await keychainItemExists(claudeKeychainService()))))
  return claudeIdentityFrom(oauth, signedIn)
}
