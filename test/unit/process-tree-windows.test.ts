import { describe, expect, it } from 'vitest'
import { agentInProcessTree, hasForegroundChild, parseWindowsProcessRows } from '../../src/main/agent/processTree'
import { agentForProcess } from '../../src/shared/agentCatalog'

const row = (...fields: Array<string | number>) => fields.join('\t')

describe('parseWindowsProcessRows', () => {
  it('先頭の実行ファイル（空白入りの引用も）を Name に置き換え、引数を残す', () => {
    const rows = parseWindowsProcessRows([
      row(100, 4, 'cmd.exe', 'C:\\Windows\\System32\\cmd.exe'),
      row(200, 100, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume'),
      row(300, 100, 'claude.exe', ''),
      'garbage',
      row('x', 1, 'a.exe', '')
    ].join('\r\n'))
    expect(rows).toEqual([
      { pid: 100, parent: 4, command: 'cmd.exe' },
      { pid: 200, parent: 100, command: 'node.exe C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume' },
      { pid: 300, parent: 100, command: 'claude.exe' }
    ])
  })

  it('cmd の子の npm 版 Claude Code を同定できる', () => {
    const rows = parseWindowsProcessRows([
      row(100, 4, 'cmd.exe', 'C:\\Windows\\System32\\cmd.exe'),
      row(200, 100, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')
    ].join('\n'))
    expect(agentInProcessTree(rows, 100, (line) => agentForProcess(line))).toBe('claude')
  })
})

describe('hasForegroundChild', () => {
  it('コンソールのホストだけならプロンプトに戻っている', () => {
    const rows = [
      { pid: 100, parent: 4, command: 'pwsh.exe -NoLogo' },
      { pid: 101, parent: 100, command: 'conhost.exe 0x4' },
      { pid: 102, parent: 100, command: 'OpenConsole.exe --headless' }
    ]
    expect(hasForegroundChild(rows, 100)).toBe(false)
    expect(hasForegroundChild([...rows, { pid: 103, parent: 100, command: 'codex.exe' }], 100)).toBe(true)
    expect(hasForegroundChild([{ pid: 103, parent: 999, command: 'codex.exe' }], 100)).toBe(false)
  })
})
