import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

const { resolveWindowsShell } = await import('../../src/main/terminal')
const { sanitizeAgentPreferences, DEFAULT_AGENT_PREFERENCES } = await import('../../src/shared/agentCatalog')

const ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }
const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const has = (...paths: string[]) => (path: string) => paths.includes(path)

describe('Windows のターミナルのシェル（↑で前のコマンドが出るように。cmd.exe は履歴を残さない）', () => {
  it('既定は PowerShell。7（pwsh）があればそれ、無ければ Windows PowerShell', () => {
    expect(DEFAULT_AGENT_PREFERENCES.windowsShell).toBe('powershell')
    expect(resolveWindowsShell('powershell', ENV, has(PWSH7, PS51))).toEqual({ file: PWSH7, args: ['-NoLogo'] })
    expect(resolveWindowsShell('powershell', ENV, has(PS51))).toEqual({ file: PS51, args: ['-NoLogo'] })
  })

  it('PowerShell が見つからない・cmd を選んだときは cmd.exe', () => {
    expect(resolveWindowsShell('powershell', ENV, has())).toEqual({ file: ENV.COMSPEC, args: [] })
    expect(resolveWindowsShell('cmd', ENV, has(PWSH7, PS51))).toEqual({ file: ENV.COMSPEC, args: [] })
  })

  it('相対の値の環境変数では探さない（プロジェクトのフォルダの pwsh.exe を拾わない）', () => {
    const env = { SystemRoot: 'Windows', ProgramFiles: '.\\tools', COMSPEC: 'cmd.exe' }
    const seen: string[] = []
    const shell = resolveWindowsShell('powershell', env, (path) => { seen.push(path); return false })
    expect(seen).toEqual([PWSH7, PS51])
    expect(shell).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [] })
  })

  it('設定の値は powershell / cmd だけ。ほかは既定に戻す', () => {
    expect(sanitizeAgentPreferences({ windowsShell: 'cmd' }).windowsShell).toBe('cmd')
    expect(sanitizeAgentPreferences({ windowsShell: 'bash' }).windowsShell).toBe('powershell')
    expect(sanitizeAgentPreferences({}).windowsShell).toBe('powershell')
  })
})
