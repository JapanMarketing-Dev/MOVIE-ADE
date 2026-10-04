import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

import { sanitize } from '../../src/main/settings'
import {
  MANAGED_ACCOUNT_MARKER,
  accountsRootFor,
  createManagedAccountDir,
  isValidAccountId,
  managedAccountDir,
  removeManagedAccountDir,
  verifyManagedAccountDir
} from '../../src/main/accounts/paths'
import { sanitizeAgentAccounts } from '../../src/main/accounts/sanitize'
import { resolveAgentEnvFrom } from '../../src/main/accounts/env'
import { applyCodexDaemonSocketGuard, carryClaudeSettings, CODEX_DAEMON_OVERRIDE_MARKER, linkSharedEntries, migrateManagedClaudeDir, pickClaudeGlobalConfig, seedManagedAccountDir } from '../../src/main/accounts/agentConfig'
import { claudeKeychainService, hasCodexCredential, readCodexIdentity } from '../../src/main/accounts/identity'
import type { AgentAccountsSettings } from '../../src/shared/accounts'
import { setLocale } from '@shared/i18n'

// 日本語の文言を確かめるテストなので、画面の言語を日本語に固定する（既定は英語）
setLocale('ja')

const ID = '11111111-2222-4333-8444-555555555555'
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let userData: string
let systemDir: string

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ade-accounts-')))
  userData = join(base, 'userData')
  systemDir = join(base, 'home', '.codex')
  mkdirSync(userData, { recursive: true })
  mkdirSync(systemDir, { recursive: true })
})

afterEach(() => {
  rmSync(join(userData, '..'), { recursive: true, force: true })
})

function accountsWith(agent: 'claude' | 'codex', activeAccountId: string | null, ids = [ID]): AgentAccountsSettings {
  const list = { accounts: ids.map((id) => ({ id, label: '', email: null, workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 })), activeAccountId }
  return { claude: { accounts: [], activeAccountId: null }, codex: { accounts: [], activeAccountId: null }, [agent]: list }
}

describe('設定フォルダのパス', () => {
  it('userData/accounts/<agent>/<id> に決まる', () => {
    expect(accountsRootFor('/u', 'codex')).toBe(join('/u', 'accounts', 'codex'))
    expect(managedAccountDir('/u', 'claude', ID)).toBe(join('/u', 'accounts', 'claude', ID))
  })

  it('UUID 以外の id はパスにしない', () => {
    expect(isValidAccountId(ID)).toBe(true)
    for (const bad of ['../x', '', 'abc', `${ID}/..`, 123, null]) expect(isValidAccountId(bad)).toBe(false)
    expect(() => managedAccountDir('/u', 'codex', '../../etc')).toThrow()
  })

  it('作ったフォルダは印つきで、本システムの物と判定される', () => {
    const dir = createManagedAccountDir(userData, 'codex', ID)
    expect(readFileSync(join(dir, MANAGED_ACCOUNT_MARKER), 'utf8').trim()).toBe(ID)
    expect(verifyManagedAccountDir({ userDataDir: userData, agent: 'codex', accountId: ID, systemDir })).toEqual({ kind: 'owned', dir })
  })

  it('既にあるフォルダは作り直さない', () => {
    createManagedAccountDir(userData, 'codex', ID)
    expect(() => createManagedAccountDir(userData, 'codex', ID)).toThrow()
  })

  it('印が無い・違う・フォルダが無いときは使わない', () => {
    expect(verifyManagedAccountDir({ userDataDir: userData, agent: 'codex', accountId: ID, systemDir }).kind).toBe('untrusted')
    const dir = createManagedAccountDir(userData, 'codex', ID)
    writeFileSync(join(dir, MANAGED_ACCOUNT_MARKER), `${ID2}\n`)
    expect(verifyManagedAccountDir({ userDataDir: userData, agent: 'codex', accountId: ID, systemDir }).kind).toBe('untrusted')
  })

  it('シンボリックリンクで既定アカウントのフォルダを指していたら使わない・消さない', () => {
    mkdirSync(accountsRootFor(userData, 'codex'), { recursive: true })
    writeFileSync(join(systemDir, MANAGED_ACCOUNT_MARKER), `${ID}\n`)
    writeFileSync(join(systemDir, 'auth.json'), '{}')
    symlinkSync(systemDir, managedAccountDir(userData, 'codex', ID))
    const verdict = verifyManagedAccountDir({ userDataDir: userData, agent: 'codex', accountId: ID, systemDir })
    expect(verdict.kind).toBe('untrusted')
    expect(removeManagedAccountDir(userData, 'codex', ID)).toBe(false)
    expect(existsSync(join(systemDir, 'auth.json'))).toBe(true)
  })

  it('本システムの物だけを消す', () => {
    const dir = createManagedAccountDir(userData, 'claude', ID)
    expect(removeManagedAccountDir(userData, 'claude', ID)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('アカウント設定の sanitize', () => {
  it('省略時は agentAccounts を足さない（既定アカウントのまま）', () => {
    expect(sanitize({}).agentAccounts).toBeUndefined()
  })

  it('壊れた行・重複・不正な id を落とし、無いアカウントを指す選択は既定へ戻す', () => {
    const result = sanitize({
      agentAccounts: {
        codex: {
          accounts: [
            { id: ID, label: '  仕事用  ', email: 'a@example.com', createdAt: 5, lastAuthenticatedAt: 6 },
            { id: ID, label: '重複' },
            { id: '../evil', label: 'x' },
            'garbage'
          ],
          activeAccountId: ID2
        },
        claude: { accounts: [{ id: ID2, label: 1, lastAuthenticatedAt: 'x' }], activeAccountId: ID2 }
      }
    }).agentAccounts!
    expect(result.codex.accounts).toEqual([
      { id: ID, label: '仕事用', email: 'a@example.com', workspaceLabel: null, createdAt: 5, updatedAt: 5, lastAuthenticatedAt: 6 }
    ])
    expect(result.codex.activeAccountId).toBeNull()
    expect(result.claude.accounts[0]).toMatchObject({ id: ID2, label: '', lastAuthenticatedAt: null })
    expect(result.claude.activeAccountId).toBe(ID2)
  })

  it('Agent が欠けていても空の一覧で補う', () => {
    expect(sanitizeAgentAccounts({ claude: { accounts: [] } })).toEqual({
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null }
    })
  })
})

describe('resolveAgentEnv', () => {
  it('システムの既定アカウントなら何も足さない', () => {
    expect(resolveAgentEnvFrom({ agent: 'codex', accounts: undefined, userDataDir: userData })).toEqual({})
    expect(resolveAgentEnvFrom({ agent: 'claude', accounts: accountsWith('claude', null), userDataDir: userData })).toEqual({})
  })

  it('Codex は CODEX_HOME を選択中のフォルダにする', () => {
    const dir = createManagedAccountDir(userData, 'codex', ID)
    expect(resolveAgentEnvFrom({ agent: 'codex', accounts: accountsWith('codex', ID), userDataDir: userData })).toEqual({ CODEX_HOME: dir })
  })

  it('Claude は CLAUDE_CONFIG_DIR を設定し、環境にある認証用の変数を空にする', () => {
    const dir = createManagedAccountDir(userData, 'claude', ID)
    const env = resolveAgentEnvFrom({
      agent: 'claude',
      accounts: accountsWith('claude', ID),
      userDataDir: userData,
      baseEnv: { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: '', PATH: '/bin' },
      systemDir
    })
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: '' })
  })

  it('一覧に無い id を指していたら既定アカウントとして扱う', () => {
    const accounts = accountsWith('codex', ID)
    accounts.codex.accounts = []
    expect(resolveAgentEnvFrom({ agent: 'codex', accounts, userDataDir: userData })).toEqual({})
  })

  it('フォルダが確かめられなければ、既定アカウントへ黙って戻さず止める', () => {
    expect(() => resolveAgentEnvFrom({ agent: 'codex', accounts: accountsWith('codex', ID), userDataDir: userData })).toThrow(/Codexアカウントを使えません/)
  })
})

describe('Codex のデーモン用ソケットの長さ対策', () => {
  const longHome = `/Users/someone/Library/Application Support/ade-movie/accounts/codex/${ID}`

  it('パスが短ければ触らない', () => {
    expect(applyCodexDaemonSocketGuard('model = "o3"\n', '/tmp/c', 'darwin')).toBe('model = "o3"\n')
  })

  it('長ければ [features] に daemon_auto_start = false を足す（2回目は変えない）', () => {
    const once = applyCodexDaemonSocketGuard('model = "o3"\n', longHome, 'darwin')
    expect(once).toContain('[features]')
    expect(once).toContain(`daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`)
    expect(applyCodexDaemonSocketGuard(once, longHome, 'darwin')).toBe(once)
  })

  it('既存の [features] の中に足し、利用者の設定があれば尊重する', () => {
    const merged = applyCodexDaemonSocketGuard('[features]\nfoo = true\n', longHome, 'darwin')
    expect(merged.split('\n').slice(0, 2)).toEqual(['[features]', `daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`])
    expect(applyCodexDaemonSocketGuard('[features]\ndaemon_auto_start = true\n', longHome, 'darwin')).toBe('[features]\ndaemon_auto_start = true\n')
  })

  it('作成時に既定アカウントの設定を写し、指示ファイルはリンクで共有する', () => {
    writeFileSync(join(systemDir, 'config.toml'), 'model = "o3"\n')
    writeFileSync(join(systemDir, 'AGENTS.md'), '# 指示\n')
    writeFileSync(join(systemDir, 'auth.json'), '{"tokens":{}}')
    const dir = createManagedAccountDir(userData, 'codex', ID)
    seedManagedAccountDir('codex', dir, systemDir)
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('model = "o3"')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# 指示\n')
    // 認証情報は持ち込まない（別アカウントでログインするため）
    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    // 既定アカウントの設定は書き換えない
    expect(readFileSync(join(systemDir, 'config.toml'), 'utf8')).toBe('model = "o3"\n')
  })
})

describe('Codex の rules の共有（Orca #24431）', () => {
  it('作成時に rules もリンクで共有する', () => {
    mkdirSync(join(systemDir, 'rules'))
    writeFileSync(join(systemDir, 'rules', 'default.rules'), 'prefix_rule(pattern=["rm"], decision="forbidden")\n')
    const dir = createManagedAccountDir(userData, 'codex', ID)
    seedManagedAccountDir('codex', dir, systemDir)
    expect(readFileSync(join(dir, 'rules', 'default.rules'), 'utf8')).toContain('forbidden')
  })

  it('以前に作ったアカウントにも、足りないリンクだけを張る（利用者が置いたものには触らない）', () => {
    const dir = createManagedAccountDir(userData, 'codex', ID)
    seedManagedAccountDir('codex', dir, systemDir)
    mkdirSync(join(systemDir, 'rules'))
    writeFileSync(join(systemDir, 'AGENTS.md'), '# 既定\n')
    writeFileSync(join(dir, 'AGENTS.md'), '# このアカウントだけ\n')
    linkSharedEntries('codex', dir, systemDir)
    linkSharedEntries('codex', dir, systemDir)
    expect(lstatSync(join(dir, 'rules')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# このアカウントだけ\n')
  })
})

describe('Claude の管理アカウントへの持ち込み', () => {
  it('全体設定は MCP と既読の印だけを写し、認証・履歴は写さない', () => {
    const picked = pickClaudeGlobalConfig({
      mcpServers: { a: { command: 'x' } },
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'me@example.com' },
      userID: 'u',
      customApiKeyResponses: { approved: ['k'] },
      projects: { '/p': { hasTrustDialogAccepted: true, history: ['秘密'] }, '/q': { hasTrustDialogAccepted: false } }
    })
    expect(picked).toEqual({
      mcpServers: { a: { command: 'x' } },
      hasCompletedOnboarding: true,
      projects: { '/p': { hasTrustDialogAccepted: true } }
    })
  })

  it('作成時に設定・全体設定を写し、プラグインなどはリンクで共有する', () => {
    const claudeHome = join(userData, '..', 'home', '.claude')
    mkdirSync(join(claudeHome, 'plugins'), { recursive: true })
    writeFileSync(join(claudeHome, 'settings.json'), '{"enabledPlugins":{}}')
    writeFileSync(join(claudeHome, '.credentials.json'), '{"claudeAiOauth":{}}')
    writeFileSync(join(userData, '..', 'home', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'x' } }))
    const dir = createManagedAccountDir(userData, 'claude', ID)
    const prev = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      seedManagedAccountDir('claude', dir, claudeHome)
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev
    }
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true })
    expect(realpathSync(join(dir, 'plugins'))).toBe(realpathSync(join(claudeHome, 'plugins')))
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
  })
})

describe('権限確認を省くモードの同意の引き継ぎ', () => {
  const claudeHome = () => {
    const dir = join(userData, '..', 'home', '.claude')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('既定アカウントで同意済みなら、追加したアカウントの settings.json に足す（ほかの値は残す）', () => {
    const home = claudeHome()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true, model: 'opus' }))
    const dir = createManagedAccountDir(userData, 'claude', ID)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    expect(carryClaudeSettings(dir, home)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skipDangerousModePermissionPrompt: true })
  })

  it('追加したアカウント側の値は上書きしない・既定で未同意なら何もしない', () => {
    const home = claudeHome()
    const dir = createManagedAccountDir(userData, 'claude', ID)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: false }))
    expect(carryClaudeSettings(dir, home)).toBe(false)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({}))
    rmSync(join(dir, 'settings.json'))
    expect(carryClaudeSettings(dir, home)).toBe(false)
    expect(existsSync(join(dir, 'settings.json'))).toBe(false)
  })

  it('既存のアカウントには起動前に1回だけ足す（2回目以降は触らない）', () => {
    const home = claudeHome()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }))
    const dir = createManagedAccountDir(userData, 'claude', ID)
    migrateManagedClaudeDir(dir, home)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt).toBe(true)
    // 利用者がこのアカウントで同意を外しても、次の起動で戻さない
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
    migrateManagedClaudeDir(dir, home)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({})
  })

  it('Agent を起動するときの環境変数の解決で、手直しが行われる', () => {
    const home = claudeHome()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }))
    const dir = createManagedAccountDir(userData, 'claude', ID)
    resolveAgentEnvFrom({ agent: 'claude', accounts: accountsWith('claude', ID), userDataDir: userData, baseEnv: {}, systemDir: home })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt).toBe(true)
  })
})

describe('設定フォルダから読むアカウント情報', () => {
  const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`

  it('Codex の auth.json からメールとプランだけを読む', () => {
    const dir = createManagedAccountDir(userData, 'codex', ID)
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'a',
        refresh_token: 'r',
        id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })
      }
    }))
    expect(readCodexIdentity(dir)).toEqual({ signedIn: true, email: 'me@example.com', workspaceLabel: 'Personal (Plus)' })
  })

  it('auth.json が無い・空・壊れているときは未ログイン', () => {
    const dir = createManagedAccountDir(userData, 'codex', ID)
    expect(readCodexIdentity(dir).signedIn).toBe(false)
    writeFileSync(join(dir, 'auth.json'), '{')
    expect(readCodexIdentity(dir).signedIn).toBe(false)
    expect(hasCodexCredential({})).toBe(false)
    expect(hasCodexCredential({ OPENAI_API_KEY: 'sk' })).toBe(true)
  })

  it('Claude の Keychain の項目名は設定フォルダごとに分かれる（Claude Code 2.1 と同じ規則）', () => {
    expect(claudeKeychainService()).toBe('Claude Code-credentials')
    expect(claudeKeychainService('/a')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(claudeKeychainService('/a')).not.toBe(claudeKeychainService('/b'))
  })
})
