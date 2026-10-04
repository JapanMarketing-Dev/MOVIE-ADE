import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** アカウントを外すとき、フォルダを消せなければ一覧に残す（Orca #11653: 認証情報だけが残って消す手段が無くなる） */
const state = vi.hoisted(() => ({ userData: '', settings: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
vi.mock('../../src/main/settings', () => ({
  currentSettings: () => state.settings,
  updateSettings: (patch: Record<string, unknown>) => { state.settings = { ...state.settings, ...patch } }
}))

import { removeAgentAccount } from '../../src/main/accounts/service'
import { createManagedAccountDir } from '../../src/main/accounts/paths'

const ID = '11111111-2222-4333-8444-555555555555'
const account = { id: ID, label: 'work', createdAt: 1, updatedAt: 1 }

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'ade-accounts-remove-'))
  state.settings = { agentAccounts: { codex: { accounts: [account], activeAccountId: ID }, claude: { accounts: [], activeAccountId: null } } }
})
afterEach(() => {
  chmodSync(join(state.userData, 'accounts', 'codex'), 0o755)
  rmSync(state.userData, { recursive: true, force: true })
})

function codexList(): { accounts: unknown[]; activeAccountId: string | null } {
  return (state.settings.agentAccounts as { codex: { accounts: unknown[]; activeAccountId: string | null } }).codex
}

describe('removeAgentAccount', () => {
  it('フォルダを消してから一覧から外す', async () => {
    const dir = createManagedAccountDir(state.userData, 'codex', ID)
    await removeAgentAccount('codex', ID).catch(() => undefined) // 一覧の読み直しは外の CLI を見るので結果は問わない
    expect(existsSync(dir)).toBe(false)
    expect(codexList()).toEqual({ accounts: [], activeAccountId: null })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('フォルダを消せなければ、一覧に残してエラーを返す', async () => {
    const dir = createManagedAccountDir(state.userData, 'codex', ID)
    // 親フォルダを書き込み禁止にして、削除を失敗させる
    chmodSync(join(state.userData, 'accounts', 'codex'), 0o555)
    await expect(removeAgentAccount('codex', ID)).rejects.toThrow()
    expect(existsSync(dir)).toBe(true)
    expect(codexList().accounts).toHaveLength(1)
    expect(codexList().activeAccountId).toBe(ID)
  })
})
