/**
 * Claude Code / Codex 以外のエージェント（Orca の TUI_AGENT_CONFIG を移植したカタログ）と、カスタムエージェント。
 * CLI もシェルも起動しない（PATH の検出は一時フォルダに置いた空の実行ファイルで確かめる）。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AGENT_CATALOG,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_PREFERENCES,
  agentForProcess,
  agentLabel,
  detectCommandsFor,
  firstCommandWord,
  newCustomAgentId,
  sanitizeAgentPreferences
} from '@shared/agentCatalog'
import { buildAgentLaunchCommand } from '@shared/agentLaunch'
import type { AgentPreferences } from '@shared/types'
import { isCommandInDirs, listAgentOptions } from '../../src/main/agentDetection'
import { detectState } from '../../src/main/agent/state'

const prefsWithCustom: AgentPreferences = {
  ...DEFAULT_AGENT_PREFERENCES,
  customAgents: [{ id: 'custom:my-agent', name: 'My Agent', command: 'my-agent', args: '--auto' }]
}

describe('カタログ（Orca の既定値）', () => {
  it('依頼された8種を含み、Orca と同じ検出コマンドと権限確認を省く引数を持つ', () => {
    for (const agent of ['gemini', 'opencode', 'cursor', 'copilot', 'aider', 'grok', 'qwen-code', 'amp'] as const) {
      expect(BUILTIN_AGENTS).toContain(agent)
    }
    expect(AGENT_CATALOG.gemini).toMatchObject({ detectCmd: 'gemini', yoloArgs: '--yolo' })
    expect(AGENT_CATALOG.cursor).toMatchObject({ detectCmd: 'cursor-agent', yoloArgs: '--yolo' })
    expect(AGENT_CATALOG['qwen-code']).toMatchObject({ detectCmd: 'qwen', yoloArgs: '--approval-mode yolo' })
    expect(AGENT_CATALOG.grok.yoloArgs).toBe('--permission-mode bypassPermissions')
    expect(AGENT_CATALOG.amp.yoloArgs).toBe('--dangerously-allow-all')
    expect(AGENT_CATALOG.aider.yoloArgs).toBe('--yes-always')
    expect(AGENT_CATALOG.opencode.yoloArgs).toBe('')
  })

  it('既定の起動コマンドはカタログから作る', () => {
    expect(DEFAULT_AGENT_PREFERENCES.launch['qwen-code']).toEqual({ command: 'qwen', args: '--approval-mode yolo' })
    expect(DEFAULT_AGENT_PREFERENCES.startupAgents).toEqual(['claude', 'codex'])
  })
})

describe('sanitizeAgentPreferences', () => {
  it('以前の形（claude / codex の launch と startupAgents だけ）を引き継ぎ、新しい項目は既定で埋める', () => {
    const prefs = sanitizeAgentPreferences({
      launch: { claude: { command: 'claude', args: '' }, codex: { command: '/opt/codex', args: '--foo' } },
      startupAgents: ['codex']
    })
    expect(prefs.launch.claude).toEqual({ command: 'claude', args: '' })
    expect(prefs.launch.codex).toEqual({ command: '/opt/codex', args: '--foo' })
    expect(prefs.launch.gemini).toEqual({ command: 'gemini', args: '--yolo' })
    expect(prefs.customAgents).toEqual([])
    expect(prefs.disabledAgents).toEqual([])
    expect(prefs.startupAgents).toEqual(['codex'])
  })

  it('id の無いカスタムは名前とコマンドが必須。書きかけでも id があれば残す。id が壊れていれば名前から作り直し、重なりを避ける', () => {
    const prefs = sanitizeAgentPreferences({
      customAgents: [
        { id: 'custom:my-agent', name: 'My Agent', command: ' my-agent ', args: ' --auto ', processName: ' ' },
        { id: 'custom:my-agent', name: 'My Agent', command: 'other' },
        { id: 'bad id', name: 'Wrapper', command: 'npx -y wrapper' },
        { name: '', command: 'x' },
        { name: 'No command', command: '  ' },
        // 設定画面で書きかけ（id はある）
        { id: 'custom:draft', name: '', command: '' }
      ],
      startupAgents: ['custom:my-agent', 'custom:gone', 'custom:draft', 'gemini'],
      disabledAgents: ['amp', 'nope']
    })
    expect(prefs.customAgents.map((custom) => custom.id)).toEqual(['custom:my-agent', 'custom:my-agent-2', 'custom:wrapper', 'custom:draft'])
    expect(prefs.customAgents[0]).toEqual({ id: 'custom:my-agent', name: 'My Agent', command: 'my-agent', args: '--auto' })
    expect(prefs.startupAgents).toEqual(['custom:my-agent', 'gemini'])
    expect(prefs.disabledAgents).toEqual(['amp'])
  })

  it('名前から id を作る（記号は - に、空なら agent）', () => {
    expect(newCustomAgentId('Kimi Code!', [])).toBe('custom:kimi-code')
    expect(newCustomAgentId('日本語だけ', [])).toBe('custom:agent')
    expect(newCustomAgentId('x', ['custom:x', 'custom:x-2'])).toBe('custom:x-3')
  })

  it('表示名はカスタムなら登録した名前', () => {
    expect(agentLabel('gemini')).toBe('Gemini CLI')
    expect(agentLabel('custom:my-agent', prefsWithCustom)).toBe('My Agent')
    expect(agentLabel('custom:gone', prefsWithCustom)).toBe('gone')
  })
})

describe('起動コマンド', () => {
  it('組み込みはコマンドが空なら既定、カスタムは空なら理由を返す', () => {
    expect(buildAgentLaunchCommand('gemini', { command: '', args: '--yolo' }, 'posix')).toEqual({
      ok: true,
      command: `gemini '--yolo'`
    })
    expect(buildAgentLaunchCommand('custom:x', { command: ' ', args: '' }, 'posix').ok).toBe(false)
    expect(buildAgentLaunchCommand('custom:x', { command: 'npx -y foo', args: '--a b' }, 'posix')).toEqual({
      ok: true,
      command: `npx -y foo '--a' 'b'`
    })
  })

  it('検出に使うコマンドは、組み込みは detectCmd、カスタムは先頭語（環境変数の代入は飛ばす）', () => {
    expect(detectCommandsFor('qwen-code', prefsWithCustom)).toEqual(['qwen'])
    expect(detectCommandsFor('custom:my-agent', prefsWithCustom)).toEqual(['my-agent'])
    expect(firstCommandWord('FOO=1 BAR=2 my-tool --x')).toBe('my-tool')
  })
})

describe('前面プロセスからの同定（Orca の agent-process-recognition）', () => {
  it('プロセス名・パス・拡張子から同定する', () => {
    expect(agentForProcess('claude')).toBe('claude')
    expect(agentForProcess('/opt/homebrew/bin/gemini')).toBe('gemini')
    expect(agentForProcess('cursor-agent')).toBe('cursor')
    expect(agentForProcess('qwen')).toBe('qwen-code')
    expect(agentForProcess('C:\\tools\\copilot.exe')).toBe('copilot')
    expect(agentForProcess('codex-aarch64-apple-darwin')).toBe('codex')
    expect(agentForProcess('zsh')).toBeNull()
  })

  it('node / python で動くCLIは、スクリプトかモジュールから同定する', () => {
    expect(agentForProcess('node /opt/homebrew/bin/gemini --yolo')).toBe('gemini')
    expect(agentForProcess('node /usr/lib/node_modules/@google/gemini-cli/dist/index.js')).toBe('gemini')
    expect(agentForProcess('node /usr/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex')
    expect(agentForProcess('python3 -m aider --yes-always')).toBe('aider')
    expect(agentForProcess('node /tmp/server.js')).toBeNull()
  })

  it('カスタムはプロセス名（無ければコマンドの先頭語）で同定し、npx などの実行系だけでは決めない', () => {
    expect(agentForProcess('my-agent --auto', prefsWithCustom)).toBe('custom:my-agent')
    const viaNpx: AgentPreferences = {
      ...DEFAULT_AGENT_PREFERENCES,
      customAgents: [{ id: 'custom:w', name: 'W', command: 'npx -y wrapper', args: '' }]
    }
    expect(agentForProcess('npx', viaNpx)).toBeNull()
    const named: AgentPreferences = {
      ...DEFAULT_AGENT_PREFERENCES,
      customAgents: [{ id: 'custom:w', name: 'W', command: 'npx -y wrapper', args: '', processName: 'wrapper' }]
    }
    expect(agentForProcess('node /x/bin/wrapper', named)).toBe('custom:w')
  })
})

describe('状態の検出（Claude Code / Codex 以外）', () => {
  it('確認待ちと処理中は汎用の手がかりで見て、それ以外は不明にする', () => {
    expect(detectState('generic', { tail: 'Do you want to proceed?\n' })).toBe('blocked')
    expect(detectState('generic', { tail: 'Thinking… (esc to interrupt)' })).toBe('working')
    expect(detectState('generic', { title: '⠙ gemini' })).toBe('working')
    expect(detectState('generic', { title: 'gemini - my-project', tail: '> ' })).toBe('unknown')
  })
})

describe('インストールの検出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-agent-detect-'))
  const make = (name: string, mode = 0o755) => {
    writeFileSync(join(dir, name), '#!/bin/sh\n')
    chmodSync(join(dir, name), mode)
  }
  make('gemini')
  make('my-agent')
  make('not-executable', 0o644)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it.skipIf(process.platform === 'win32')('PATH のフォルダにある実行ファイルだけを見つける', () => {
    expect(isCommandInDirs('gemini', [dir])).toBe(true)
    expect(isCommandInDirs('not-executable', [dir])).toBe(false)
    expect(isCommandInDirs('amp', [dir])).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('一覧は組み込み → カスタムの順で、検出と無効を合わせる', async () => {
    const original = process.env.PATH
    process.env.PATH = dir
    try {
      const options = await listAgentOptions({ ...prefsWithCustom, disabledAgents: ['gemini'] }, true)
      const gemini = options.find((o) => o.id === 'gemini')
      expect(gemini).toMatchObject({ installed: true, enabled: false, custom: false, defaultArgs: '--yolo' })
      expect(options.find((o) => o.id === 'custom:my-agent')).toMatchObject({ installed: true, enabled: true, custom: true, label: 'My Agent' })
      expect(options.map((o) => o.id).slice(0, 2)).toEqual(['claude', 'codex'])
      expect(options[options.length - 1]?.id).toBe('custom:my-agent')
    } finally {
      process.env.PATH = original
    }
  })
})
