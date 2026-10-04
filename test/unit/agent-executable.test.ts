import { describe, expect, it } from 'vitest'
import { resolveTrustedCommand, splitLeadingCommand, windowsSearchPathEnv } from '../../src/main/agentExecutable'
import type { WindowsFs } from '../../src/main/platform/windowsSpawn'

/** security-4 [1]: Windows で組み込みの Agent・ログインをプロジェクトのフォルダから解決しない */

function fakeFs(files: string[]): WindowsFs {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return { fileSize: (p) => (set.has(p.toLowerCase()) ? 100 : null), readText: () => null }
}

const PROJECT = 'C:\\work\\evil-project'
const NPM = 'C:\\Users\\dev\\AppData\\Roaming\\npm'

describe('resolveTrustedCommand (security-4 [1])', () => {
  it('resolves a bare built-in name to the absolute PATH entry, not the project shim', () => {
    const fs = fakeFs([`${PROJECT}\\claude.cmd`, `${NPM}\\claude.cmd`])
    const r = resolveTrustedCommand('claude --model x', { platform: 'win32', env: { PATH: NPM, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, cwd: PROJECT, shell: 'cmd', fs })
    expect(r).toEqual({ ok: true, command: `"${NPM}\\claude.cmd" --model x` })
  })

  it('fails closed when the CLI is only in the project folder', () => {
    const fs = fakeFs([`${PROJECT}\\codex.cmd`, `${PROJECT}\\codex.exe`])
    const r = resolveTrustedCommand('codex', { platform: 'win32', env: { PATH: NPM }, cwd: PROJECT, shell: 'cmd', fs })
    expect(r.ok).toBe(false)
  })

  it('ignores PATH entries that are relative or inside the project', () => {
    const fs = fakeFs([`${PROJECT}\\node_modules\\.bin\\claude.cmd`, `.\\claude.cmd`])
    const env = { Path: `.;${PROJECT}\\node_modules\\.bin;${PROJECT}` }
    expect(resolveTrustedCommand('claude', { platform: 'win32', env, cwd: PROJECT, shell: 'cmd', fs }).ok).toBe(false)
  })

  it('rejects relative paths that depend on the working folder', () => {
    const fs = fakeFs([])
    for (const command of ['.\\claude.cmd', 'bin/claude', 'C:claude.exe']) {
      expect(resolveTrustedCommand(command, { platform: 'win32', env: { PATH: NPM }, cwd: PROJECT, shell: 'cmd', fs })).toEqual({ ok: false, reason: 'relative' })
    }
  })

  it('keeps an absolute command the user configured, quoted for PowerShell', () => {
    const exe = 'C:\\Program Files\\Claude\\claude.exe'
    const fs = fakeFs([exe])
    const r = resolveTrustedCommand(`"${exe}" auth login`, { platform: 'win32', env: { PATH: '' }, cwd: PROJECT, shell: 'powershell', fs })
    expect(r).toEqual({ ok: true, command: `& '${exe}' auth login` })
  })

  it('leaves macOS and Linux commands unchanged (those shells do not search the working folder)', () => {
    expect(resolveTrustedCommand('claude', { platform: 'darwin', env: {}, cwd: '/p', shell: 'posix' })).toEqual({ ok: true, command: 'claude' })
  })

  it('splits a quoted leading command', () => {
    expect(splitLeadingCommand('"C:\\a b\\x.exe" -y')).toEqual({ head: 'C:\\a b\\x.exe', rest: ' -y' })
    expect(splitLeadingCommand('codex login')).toEqual({ head: 'codex', rest: ' login' })
  })

  it('tells cmd.exe not to search the working folder on Windows only', () => {
    expect(windowsSearchPathEnv('win32')).toEqual({ NoDefaultCurrentDirectoryInExePath: '1' })
    expect(windowsSearchPathEnv('linux')).toEqual({})
  })
})
