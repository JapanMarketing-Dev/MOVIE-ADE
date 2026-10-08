/**
 * Sentry の FERRET-M（main のイベントループが止まる）と FERRET-K（起動が遅い）の再発防止。
 * - アカウントの一覧は .claude.json の oauthAccount だけを取り出して読む（丸ごと JSON.parse しない）
 * - Agent の起動のたびに .claude.json を読み直さない（この起動で信頼を書いたフォルダは覚える）
 * - 起動の直後はリソースの取得（Windows は PowerShell）を待つ
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { extractJsonObject, readClaudeIdentity } from '../../src/main/accounts/identity'
import { applyAgentWorkspaceTrust, resetTrustMemo } from '../../src/main/agentWorkspaceTrust'
import { firstSnapshotDelay } from '../../src/renderer/lib/resourceSnapshot'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); resetTrustMemo() })

describe('FERRET-M：.claude.json の oauthAccount だけを読む', () => {
  it('上の階層の oauthAccount を、文字列の中の括弧に惑わされずに切り出す', () => {
    const text = JSON.stringify({ projects: { '/a': { history: [{ display: 'a "oauthAccount" { } }' }] } }, oauthAccount: { emailAddress: 'u@example.com', organizationName: 'Org {x}' }, tail: 1 })
    expect(JSON.parse(extractJsonObject(text, 'oauthAccount')!)).toEqual({ emailAddress: 'u@example.com', organizationName: 'Org {x}' })
    expect(extractJsonObject('{"projects":{}}', 'oauthAccount')).toBeNull()
    expect(extractJsonObject('{"oauthAccount": null}', 'oauthAccount')).toBeNull()
    expect(extractJsonObject('{"oauthAccount": {"a": 1', 'oauthAccount')).toBeNull()
  })

  it('大きな .claude.json（数十 MB）でも速く読み、メールを返す。main の同期の読み込みは使わない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferret-claude-'))
    roots.push(dir)
    const projects = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`/p/${i}`, { history: Array.from({ length: 40 }, () => ({ display: 'x'.repeat(100) })) }]))
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects, oauthAccount: { emailAddress: 'dev@example.com' } }))
    writeFileSync(join(dir, '.credentials.json'), '{}')
    const started = performance.now()
    const identity = await readClaudeIdentity(dir)
    const ms = performance.now() - started
    expect(identity).toMatchObject({ signedIn: true, email: 'dev@example.com' })
    expect(ms).toBeLessThan(400)
    const source = readFileSync(new URL('../../src/main/accounts/identity.ts', import.meta.url), 'utf8')
    expect(source).toContain("extractJsonObject(text, 'oauthAccount')")
    expect(source).toMatch(/readClaudeOauthAccount\(configPaths: string\[\]\): Promise/)
  })
})

describe('FERRET-M：Agent の起動ごとに .claude.json を読み直さない', () => {
  it('同じ設定ファイルとフォルダは、この起動で2回目から読まない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ferret-trust-'))
    roots.push(root)
    const home = join(root, 'home')
    const project = join(root, 'project')
    mkdirSync(home)
    mkdirSync(project)
    const file = join(home, '.claude.json')
    writeFileSync(file, '{}')
    expect(await applyAgentWorkspaceTrust({ agent: 'claude', cwd: project, projectFolders: [project], env: {}, homeDir: home })).toBe('granted')
    // 書いたあとに壊しても、同じ起動の間は読みに行かない
    writeFileSync(file, '{broken')
    expect(await applyAgentWorkspaceTrust({ agent: 'claude', cwd: project, projectFolders: [project], env: {}, homeDir: home })).toBe('unchanged')
    expect(readFileSync(file, 'utf8')).toBe('{broken')
    resetTrustMemo()
    expect(await applyAgentWorkspaceTrust({ agent: 'claude', cwd: project, projectFolders: [project], env: {}, homeDir: home })).toBe('unreadable')
  })
})

describe('FERRET-K：起動の直後はリソースの取得を待つ', () => {
  it('画面を読み込んでから 8 秒までは待ち、それ以降は待たない', () => {
    expect(firstSnapshotDelay(1200)).toBe(6800)
    expect(firstSnapshotDelay(20_000)).toBe(0)
  })
})
