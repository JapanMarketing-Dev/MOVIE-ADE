import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { claudeKeychainService } from '../accounts/identity'

/**
 * 使用量の取得に使うアクセストークンを読む。値はメモリの中だけで使い、返り値以外へは出さない
 * （ログ・画面・例外のメッセージに含めない）。
 *
 * Orca由来: ~/bench/orca/src/main/rate-limits/claude-oauth-credentials.ts,
 *           ~/bench/orca/src/main/rate-limits/codex-backend-auth.ts（MIT, Copyright 2026 Lovecast Inc.）
 */

export type CredentialRead = { token: string; accountId?: string | null } | { token: null; reason: 'missing' | 'keychain-unavailable' }

function keychainUser(): string {
  try {
    const user = process.env.USER || process.env.USERNAME || userInfo().username
    return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
  } catch {
    return 'claude-code-user'
  }
}

/** Keychain の項目の中身を読む。無ければ null、読めなければ 'unavailable' */
function readKeychainPassword(service: string): Promise<string | null | 'unavailable'> {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-a', keychainUser(), '-w'], { timeout: 5000 }, (error, stdout) => {
      if (!error) return resolve(stdout.trim() || null)
      // 44 は「項目が無い」。それ以外（ロック中・拒否）は読めなかったとして扱う
      resolve((error as { code?: unknown }).code === 44 ? null : 'unavailable')
    })
  })
}

function parseClaudeAccessToken(raw: string): string | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
    return typeof oauth?.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : null
  } catch {
    return null
  }
}

/**
 * Claude の OAuth アクセストークン。
 * configDir を渡すと、その CLAUDE_CONFIG_DIR 用の Keychain の項目と .credentials.json を見る。
 * 省略するとシステムの既定アカウント（無印の項目と ~/.claude/.credentials.json）。
 */
export async function readClaudeAccessToken(configDir?: string): Promise<CredentialRead> {
  let keychainUnavailable = false
  if (process.platform === 'darwin') {
    const raw = await readKeychainPassword(claudeKeychainService(configDir))
    if (raw === 'unavailable') keychainUnavailable = true
    else if (raw) {
      const token = parseClaudeAccessToken(raw)
      if (token) return { token }
    }
  }
  try {
    const token = parseClaudeAccessToken(await readFile(join(configDir ?? join(homedir(), '.claude'), '.credentials.json'), 'utf8'))
    if (token) return { token }
  } catch {
    // ファイルが無ければ Keychain の結果で決める
  }
  return { token: null, reason: keychainUnavailable ? 'keychain-unavailable' : 'missing' }
}

/** Codex の auth.json のアクセストークンと ChatGPT のアカウント id */
export async function readCodexAccessToken(codexHome: string): Promise<CredentialRead> {
  try {
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } }
    const token = auth.tokens?.access_token
    if (typeof token === 'string' && token) {
      return { token, accountId: typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id : null }
    }
  } catch {
    // 読めなければ未ログイン
  }
  return { token: null, reason: 'missing' }
}
