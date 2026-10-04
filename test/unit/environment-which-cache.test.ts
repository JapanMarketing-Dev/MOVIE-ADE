import { describe, expect, it, vi } from 'vitest'

/**
 * which は capture:availability（指摘の画面を開くたび）などで何度も呼ばれる。結果を30秒覚える（src/main/pipeline/environment.ts）。
 * macOS / Linux は which を起動せず PATH のフォルダを見る。Windows の where は非同期で起動する（プロセスを同期で起動して main を止めない。FERRET-M）
 */
const isWindows = process.platform === 'win32'
const found = (cmd: string) => (isWindows ? `C:\\tools\\${cmd}.exe` : `/usr/local/bin/${cmd}`)
const execFile = vi.fn((_cmd: string, args: string[], _opts: unknown, done: (err: Error | null, stdout: string) => void) => {
  if (args[0] === 'missing-cmd') done(new Error('not found'), '')
  else done(null, `${found(args[0]!)}\r\n`)
})
const execFileSync = vi.fn()
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), execFile, execFileSync }))
const statSync = vi.fn((path: string) => {
  if (path !== found('whisper-cli')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return { isFile: () => true }
})
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), statSync, accessSync: vi.fn() }))

describe('which の結果を覚える', () => {
  it('同じコマンドは30秒のあいだ1度だけ探す（見つからないことも覚える）', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const savedPath = process.env.PATH
    process.env.PATH = '/opt/homebrew/bin:/usr/local/bin'
    try {
      const { nodeProbes } = await import('../../src/main/pipeline/environment')
      // 探した回数（Windows は where の起動、macOS / Linux は PATH の2つのフォルダを見る）
      const searches = () => (isWindows ? execFile.mock.calls.length : statSync.mock.calls.length / 2)
      const probes = nodeProbes()
      expect(await probes.which('whisper-cli')).toBe(found('whisper-cli'))
      expect(await nodeProbes().which('whisper-cli')).toBe(found('whisper-cli'))
      expect(await probes.which('missing-cmd')).toBeNull()
      expect(await probes.which('missing-cmd')).toBeNull()
      expect(searches()).toBe(2)
      vi.setSystemTime(1_000_000 + 31_000)
      await probes.which('whisper-cli')
      expect(searches()).toBe(3)
      // 同期でプロセスを起動しない（macOS / Linux は which も起動しない）
      expect(execFileSync).not.toHaveBeenCalled()
      if (!isWindows) expect(execFile).not.toHaveBeenCalled()
    } finally {
      process.env.PATH = savedPath
      vi.useRealTimers()
    }
  })
})

describe('Windows の where', () => {
  it('非同期で起動し、探している途中の呼び出しも1回にまとめる', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.resetModules()
    execFile.mockClear()
    execFileSync.mockClear()
    try {
      const { nodeProbes } = await import('../../src/main/pipeline/environment')
      const probes = nodeProbes()
      const [a, b] = await Promise.all([probes.which('codex'), probes.which('codex')])
      expect(a).toBe(b)
      expect(execFile).toHaveBeenCalledTimes(1)
      expect(execFile.mock.calls[0]![0]).toBe('where')
      expect(execFileSync).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })
})

describe('findOnPath', () => {
  it('PATH の前のフォルダから順に、実行できる最初のファイルを返す', async () => {
    const { findOnPath } = await import('../../src/main/pipeline/environment')
    const exe = new Set(['/usr/local/bin/claude', '/usr/bin/claude'])
    expect(findOnPath('claude', '/opt/homebrew/bin::/usr/local/bin/:/usr/bin', (p) => exe.has(p))).toBe('/usr/local/bin/claude')
    expect(findOnPath('codex', '/usr/local/bin:/usr/bin', (p) => exe.has(p))).toBeNull()
  })

  it('区切りの入ったコマンドや空の PATH は探さない', async () => {
    const { findOnPath } = await import('../../src/main/pipeline/environment')
    const isExecutable = vi.fn(() => true)
    expect(findOnPath('../claude', '/usr/bin', isExecutable)).toBeNull()
    expect(findOnPath('', '/usr/bin', isExecutable)).toBeNull()
    expect(findOnPath('claude', '', isExecutable)).toBeNull()
    expect(isExecutable).not.toHaveBeenCalled()
  })
})
