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
    // 利用者名が取れない環境は Claude Code と同じ既定値（想定内）
    return 'claude-code-user'
  }
}

/**
 * macOS の Keychain を `security` コマンド経由で読む（Orca の generic-password.ts と同じ方式）。
 * Electron から Keychain の API を直接呼ばない。Claude Code 自身も `security` で読み書きするため、
 * Claude Code が作った項目は、ふつう確認のダイアログなしで読める。
 *
 * それでも許可を求められる環境では、待たずに諦める：
 * - 入力は閉じ（stdin を使わない）、3秒で強制終了する（ダイアログの応答を待ち続けない）
 * - 一度読めなかった項目は、このセッションの間は自動では読みに行かない（手動の再読み込みでだけ試す）
 * - 中身を読む前に、項目が「あるか」だけを属性の読み取り（-w なし。許可は要らない）で確かめる
 */
export const KEYCHAIN_COMMAND_TIMEOUT_MS = 3000

export type SecurityExec = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; code: unknown }>

const execSecurity: SecurityExec = (args) =>
  new Promise((resolve) => {
    let settled = false
    const done = (result: Awaited<ReturnType<SecurityExec>>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = execFile('security', args, { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout) =>
      done(error ? { ok: false, code: (error as { code?: unknown }).code } : { ok: true, stdout: String(stdout) })
    )
    child.stdin?.end()
    // execFile の timeout が効かなかったときの保険（コールバックが来ないまま残さない）
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ ok: false, code: 'ETIMEDOUT' })
    }, KEYCHAIN_COMMAND_TIMEOUT_MS + 500)
  })

/** 項目が無い（44）。それ以外の失敗は「読めなかった」（拒否・タイムアウト・ロック中） */
const NOT_FOUND = 44

export function createKeychainReader(exec: SecurityExec = execSecurity) {
  /** 読めなかった項目。手動の再読み込み（retryBlocked）まで自動では読まない */
  const blocked = new Set<string>()
  return {
    async read(service: string, account: string, options: { retryBlocked?: boolean } = {}): Promise<string | null | 'unavailable'> {
      const key = `${service}\u0000${account}`
      if (blocked.has(key) && !options.retryBlocked) return 'unavailable'
      const exists = await exec(['find-generic-password', '-s', service, '-a', account])
      if (!exists.ok) return exists.code === NOT_FOUND ? null : 'unavailable'
      const result = await exec(['find-generic-password', '-s', service, '-a', account, '-w'])
      if (result.ok) {
        blocked.delete(key)
        return result.stdout.trim() || null
      }
      if (result.code === NOT_FOUND) return null
      blocked.add(key)
      return 'unavailable'
    }
  }
}

const keychain = createKeychainReader()

function parseClaudeAccessToken(raw: string): string | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
    return typeof oauth?.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : null
  } catch {
    // 資格情報の形でない（未ログイン扱い。想定内。トークンを含むので送らない）
    return null
  }
}

/**
 * Claude の OAuth アクセストークン。
 * configDir を渡すと、その CLAUDE_CONFIG_DIR 用の Keychain の項目と .credentials.json を見る。
 * 省略するとシステムの既定アカウント（無印の項目と ~/.claude/.credentials.json）。
 */
export async function readClaudeAccessToken(configDir?: string, options: { retryBlocked?: boolean } = {}): Promise<CredentialRead> {
  // ファイル（Linux・Windows、または macOS でファイルに置いている場合）を先に見る。Keychain に触れずに済む
  try {
    const token = parseClaudeAccessToken(await readFile(join(configDir ?? join(homedir(), '.claude'), '.credentials.json'), 'utf8'))
    if (token) return { token }
  } catch {
    // 無ければ Keychain を見る
  }
  if (process.platform !== 'darwin') return { token: null, reason: 'missing' }
  const raw = await keychain.read(claudeKeychainService(configDir), keychainUser(), options)
  if (raw === 'unavailable') return { token: null, reason: 'keychain-unavailable' }
  const token = raw ? parseClaudeAccessToken(raw) : null
  return token ? { token } : { token: null, reason: 'missing' }
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
