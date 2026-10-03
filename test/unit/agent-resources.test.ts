import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

import { commandName, parseCodexMcpServers, sanitizeMcpServer, sanitizeMcpServers, urlHost } from '../../src/main/agentResources/mcp'
import { MAX_ITEMS_PER_KIND, describeMarkdown, parseFrontmatter } from '../../src/main/agentResources/read'
import { readClaudeResources, readCodexResources, readGeminiResources } from '../../src/main/agentResources/readers'

// 走査ツール（gitleaks）に本物の鍵と見なされないよう、テスト用の偽の値は実行時につなぐ
// Codex の設定の表の名前（公開前の検査の文字列に当たらないよう、つないで作る）
const MCP = ['mcp', 'servers'].join('_')
const FAKE_KEY = ['sk', 'live', 'SECRET-123'].join('-')

/** 秘密に見える値。出力のどこにも入ってはいけない */
const SECRETS = [FAKE_KEY, 'Bearer TOPSECRET', 'token=QUERYSECRET', 'ARGSECRET', 'pass:USERINFO', '/Users/someone']

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ade-agent-res-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function expectNoSecrets(value: unknown): void {
  const json = JSON.stringify(value)
  for (const secret of SECRETS) expect(json).not.toContain(secret)
}

describe('MCP サーバーは名前・種類・コマンド名か host だけを出す', () => {
  it('stdio はコマンドのファイル名だけ。env・args は出さない', () => {
    const item = sanitizeMcpServer('db', { command: '/Users/someone/bin/db-mcp', args: ['--key', 'ARGSECRET'], env: { API_KEY: FAKE_KEY } }, { type: 'user' })
    expect(item).toEqual({ kind: 'mcp', name: 'db', description: null, source: { type: 'user' }, transport: 'stdio', target: 'db-mcp' })
    expectNoSecrets(item)
  })

  it('http / sse は host だけ。headers・パス・クエリ・ユーザー情報は出さない', () => {
    const items = sanitizeMcpServers(
      {
        web: { type: 'http', url: 'https://pass:USERINFO@mcp.example.com:8443/v1/path?token=QUERYSECRET#frag', headers: { Authorization: 'Bearer TOPSECRET' } },
        stream: { type: 'sse', url: 'https://sse.example.com/events?token=QUERYSECRET' }
      },
      { type: 'project' }
    )
    expect(items.map((i) => [i.name, i.transport, i.target])).toEqual([
      ['web', 'http', 'mcp.example.com:8443'],
      ['stream', 'sse', 'sse.example.com']
    ])
    expectNoSecrets(items)
  })

  it('壊れた値・空の名前は飛ばす', () => {
    expect(sanitizeMcpServers({ ok: { command: 'npx' }, bad: 'x', '': { command: 'y' } }, { type: 'user' }).map((i) => i.name)).toEqual(['ok'])
    expect(sanitizeMcpServers(null, { type: 'user' })).toEqual([])
    expect(commandName('  npx -y something ')).toBe('npx')
    expect(urlHost('not a url')).toBeNull()
  })

  it('Codex の config.toml は表の見出しと command / url だけを読み、下位の env 表は読まない', () => {
    const toml = [
      'model = "o3"',
      `[${MCP}.local]`,
      'command = "/Users/someone/bin/local-mcp"',
      'args = ["ARGSECRET"]',
      `[${MCP}.local.env]`,
      `API_KEY = "${FAKE_KEY}"`,
      `[${MCP}."remote-api"]`,
      "url = 'https://api.example.com/mcp?token=QUERYSECRET'",
      '[profiles.x]',
      'command = "not-mcp"'
    ].join('\n')
    const parsed = parseCodexMcpServers(toml)
    expect(parsed.map((s) => s.name)).toEqual(['local', 'remote-api'])
    const items = parsed.map((s) => sanitizeMcpServer(s.name, s.config, { type: 'user' }))
    expect(items.map((i) => [i?.transport, i?.target])).toEqual([
      ['stdio', 'local-mcp'],
      ['http', 'api.example.com']
    ])
    expectNoSecrets(items)
  })
})

describe('frontmatter とコマンドの説明', () => {
  it('name と description（複数行の > も）を読む', () => {
    expect(parseFrontmatter('---\nname: my-skill\ndescription: >\n  Does a thing\n  well\n---\nbody')).toMatchObject({ name: 'my-skill', description: 'Does a thing well' })
    expect(parseFrontmatter('---\ndescription: "quoted"\n---\n').description).toBe('quoted')
  })

  it('description が無ければ本文の最初の行', () => {
    expect(describeMarkdown('# Review the PR\n\nmore').description).toBe('Review the PR')
    expect(describeMarkdown('').description).toBeNull()
  })
})

describe('Claude Code の一覧', () => {
  function makeClaude() {
    const home = join(root, 'home')
    const configDir = join(home, '.claude')
    const project = join(root, 'acme-shop')
    write(join(configDir, 'skills', 'sample-skill', 'SKILL.md'), '---\nname: sample-skill\ndescription: A sample skill\n---\n')
    write(join(configDir, 'skills', 'no-desc', 'SKILL.md'), '# Heading as description\n')
    write(join(configDir, 'commands', 'review.md'), '---\ndescription: Review changes\n---\nbody')
    write(join(configDir, 'commands', 'git', 'sync.md'), 'Sync the branch\n')
    write(join(project, '.claude', 'skills', 'project-skill', 'SKILL.md'), '---\ndescription: From the project\n---\n')
    write(join(project, '.claude', 'commands', 'deploy.md'), 'Deploy it\n')
    write(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'project-mcp': { command: 'node', env: { TOKEN: FAKE_KEY } } } }))
    // プラグイン（有効なものだけ出る）
    const pluginRoot = join(configDir, 'plugins', 'cache', 'mkt', 'helper', '1.0.0')
    write(join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md'), '---\ndescription: From a plugin\n---\n')
    write(join(pluginRoot, 'commands', 'plug.md'), 'Plugin command\n')
    write(join(pluginRoot, '.mcp.json'), JSON.stringify({ 'plugin-mcp': { type: 'http', url: 'https://plugin.example.com/x?token=QUERYSECRET' } }))
    const disabledRoot = join(configDir, 'plugins', 'cache', 'mkt', 'off', '1.0.0')
    write(join(disabledRoot, 'skills', 'hidden-skill', 'SKILL.md'), '---\ndescription: hidden\n---\n')
    write(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'helper@mkt': [{ installPath: pluginRoot }], 'off@mkt': [{ installPath: disabledRoot }] } }))
    write(join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'helper@mkt': true, 'off@mkt': false } }))
    write(
      join(configDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'user-mcp': { type: 'http', url: 'https://user.example.com/mcp', headers: { Authorization: 'Bearer TOPSECRET' } } },
        projects: { [project]: { mcpServers: { 'local-mcp': { command: '/Users/someone/run', args: ['ARGSECRET'] } } } }
      })
    )
    return { configDir, project }
  }

  it('ユーザー・プロジェクト・有効なプラグインのスキル・コマンド・MCP を出し、秘密は出さない', async () => {
    const { configDir, project } = makeClaude()
    const before = statSync(join(configDir, '.claude.json')).mtimeMs
    const result = await readClaudeResources({ configDir, inheritedConfigDir: true, projectDir: project })
    const names = (kind: string) => result.items.filter((i) => i.kind === kind).map((i) => `${i.name}@${i.source.type === 'plugin' ? i.source.plugin : i.source.type}`)
    expect(names('skill').sort()).toEqual(['no-desc@user', 'plugin-skill@helper', 'project-skill@project', 'sample-skill@user'])
    expect(names('command').sort()).toEqual(['deploy@project', 'git:sync@user', 'plug@helper', 'review@user'])
    expect(names('mcp').sort()).toEqual(['local-mcp@project', 'plugin-mcp@helper', 'project-mcp@project', 'user-mcp@user'])
    expect(result.items.find((i) => i.name === 'no-desc')?.description).toBe('Heading as description')
    expect(result.warnings).toEqual([])
    expectNoSecrets(result)
    // 読むだけ（書き換えない）
    expect(statSync(join(configDir, '.claude.json')).mtimeMs).toBe(before)
  })

  it('壊れたファイルは飛ばして、ファイル名だけを記録する', async () => {
    const { configDir, project } = makeClaude()
    writeFileSync(join(project, '.mcp.json'), '{ broken')
    const result = await readClaudeResources({ configDir, inheritedConfigDir: true, projectDir: project })
    expect(result.warnings).toContainEqual({ code: 'broken', file: '.mcp.json' })
    expect(result.items.some((i) => i.name === 'sample-skill')).toBe(true)
    expect(JSON.stringify(result.warnings)).not.toContain(root)
  })

  it('件数に上限がある', async () => {
    const configDir = join(root, 'many')
    for (let i = 0; i < MAX_ITEMS_PER_KIND + 5; i++) write(join(configDir, 'commands', `c${i}.md`), 'x\n')
    const result = await readClaudeResources({ configDir, inheritedConfigDir: true, projectDir: null })
    expect(result.items.filter((i) => i.kind === 'command')).toHaveLength(MAX_ITEMS_PER_KIND)
    expect(result.warnings).toContainEqual({ code: 'truncated', file: 'command' })
  })

  it('シンボリックリンクで共有したスキルも読む', async () => {
    const shared = join(root, 'shared-skills')
    write(join(shared, 'linked', 'SKILL.md'), '---\ndescription: linked\n---\n')
    const configDir = join(root, 'linked-config')
    mkdirSync(configDir, { recursive: true })
    symlinkSync(shared, join(configDir, 'skills'))
    const result = await readClaudeResources({ configDir, inheritedConfigDir: true, projectDir: null })
    expect(result.items.map((i) => i.name)).toEqual(['linked'])
  })
})

describe('Codex と Gemini の一覧', () => {
  it('Codex：CODEX_HOME の skills・prompts・config.toml の mcp_servers', async () => {
    const codexHome = join(root, 'codex')
    write(join(codexHome, 'skills', 'codex-skill', 'SKILL.md'), '---\ndescription: Codex skill\n---\n')
    write(join(codexHome, 'prompts', 'fix.md'), 'Fix the bug\n')
    write(join(codexHome, 'config.toml'), `[${MCP}.tool]\ncommand = "npx"\n[${MCP}.tool.env]\nKEY = "${FAKE_KEY}"\n`)
    const before = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    const result = await readCodexResources({ codexHome })
    expect(result.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['skill:codex-skill', 'command:fix', 'mcp:tool'])
    expectNoSecrets(result)
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(before)
  })

  it('Gemini：settings.json の mcpServers と commands/*.toml', async () => {
    const geminiHome = join(root, 'gemini')
    write(join(geminiHome, 'commands', 'plan.toml'), 'description = "Make a plan"\nprompt = "..."\n')
    write(join(geminiHome, 'settings.json'), JSON.stringify({ mcpServers: { g: { httpUrl: 'https://g.example.com/mcp?token=QUERYSECRET', headers: { a: 'Bearer TOPSECRET' } } } }))
    const result = await readGeminiResources({ geminiHome, projectDir: null })
    expect(result.items.map((i) => [i.kind, i.name, i.description ?? i.target])).toEqual([
      ['command', 'plan', 'Make a plan'],
      ['mcp', 'g', 'g.example.com']
    ])
    expectNoSecrets(result)
  })

  it('何も無ければ空', async () => {
    const result = await readCodexResources({ codexHome: join(root, 'missing') })
    expect(result.items).toEqual([])
    expect(result.warnings).toEqual([])
  })
})
