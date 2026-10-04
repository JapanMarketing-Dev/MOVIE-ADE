import { describe, expect, it } from 'vitest'
import { resolveTrustedExecutable, trustedLaunchLine, windowsSearchPathEnv } from '../../src/main/agentExecutable'
import type { WindowsFs } from '../../src/main/platform/windowsSpawn'

/** security-4 [1]: Windows で組み込みの Agent・ログインをプロジェクトのフォルダから解決しない（POSIX は security-5-agents.test.ts） */

function fakeFs(files: string[]): WindowsFs {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return { fileSize: (p) => (set.has(p.toLowerCase()) ? 100 : null), readText: () => null }
}

const PROJECT = 'C:\\work\\evil-project'
const HOME = 'C:\\Users\\taro'
const NPM = `${HOME}\\AppData\\Roaming\\npm`

const win = (env: NodeJS.ProcessEnv, fs: WindowsFs, cwd = PROJECT) => ({ platform: 'win32' as const, env, cwd, home: HOME, fs })

describe('resolveTrustedExecutable on Windows (security-4 [1])', () => {
  it('resolves a bare built-in name to the absolute PATH entry, not the project shim', async () => {
    const fs = fakeFs([`${PROJECT}\\claude.cmd`, `${NPM}\\claude.cmd`])
    const r = await resolveTrustedExecutable('claude', win({ PATH: NPM, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, fs))
    expect(r).toEqual({ ok: true, path: `${NPM}\\claude.cmd` })
    if (r.ok) expect(trustedLaunchLine(r.path, ['--model', 'x'], 'cmd')).toBe(`"${NPM}\\claude.cmd" "--model" "x"`)
  })

  it('fails closed when the CLI is only in the project folder', async () => {
    const fs = fakeFs([`${PROJECT}\\codex.cmd`, `${PROJECT}\\codex.exe`])
    expect((await resolveTrustedExecutable('codex', win({ PATH: NPM }, fs))).ok).toBe(false)
  })

  it('ignores PATH entries that are relative or inside the project', async () => {
    const fs = fakeFs([`${PROJECT}\\node_modules\\.bin\\claude.cmd`, `.\\claude.cmd`])
    const env = { Path: `.;${PROJECT}\\node_modules\\.bin;${PROJECT}` }
    expect((await resolveTrustedExecutable('claude', win(env, fs))).ok).toBe(false)
  })

  it('rejects relative paths that depend on the working folder', async () => {
    for (const command of ['.\\claude.cmd', 'bin/claude', 'C:claude.exe']) {
      expect(await resolveTrustedExecutable(command, win({ PATH: NPM }, fakeFs([])))).toEqual({ ok: false, reason: 'relative' })
    }
  })

  it('keeps an absolute command the user configured, quoted for PowerShell', async () => {
    const exe = 'C:\\Program Files\\Claude\\claude.exe'
    const r = await resolveTrustedExecutable(exe, win({ PATH: '' }, fakeFs([exe])))
    expect(r).toEqual({ ok: true, path: exe })
    if (r.ok) expect(trustedLaunchLine(r.path, ['auth', 'login'], 'powershell')).toBe(`& '${exe}' 'auth' 'login'`)
  })

  it('logins run from home and still find CLIs installed under home', async () => {
    const fs = fakeFs([`${NPM}\\claude.cmd`])
    expect(await resolveTrustedExecutable('claude', win({ PATH: NPM }, fs, HOME))).toEqual({ ok: true, path: `${NPM}\\claude.cmd` })
  })

  it('tells cmd.exe not to search the working folder on Windows only', () => {
    expect(windowsSearchPathEnv('win32')).toEqual({ NoDefaultCurrentDirectoryInExePath: '1' })
    expect(windowsSearchPathEnv('linux')).toEqual({})
  })
})
