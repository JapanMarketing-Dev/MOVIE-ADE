import { describe, expect, it, vi } from 'vitest'

/**
 * which / where を同期で起動すると main が止まるので、結果を30秒覚える（src/main/pipeline/environment.ts）。
 */
// which（macOS / Linux）と where（Windows）の出力の形に合わせる。where は拡張子付きのパスを返す
const isWindows = process.platform === 'win32'
const found = (cmd: string) => (isWindows ? `C:\\tools\\${cmd}.exe` : `/usr/local/bin/${cmd}`)
const execFileSync = vi.fn((_cmd: string, args: string[]) => {
  if (args[0] === 'missing-cmd') throw new Error('not found')
  return `${found(args[0]!)}\r\n`
})
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), execFileSync }))

describe('which の結果を覚える', () => {
  it('同じコマンドは30秒のあいだ1度だけ起動する（見つからないことも覚える）', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { nodeProbes } = await import('../../src/main/pipeline/environment')
    const probes = nodeProbes()
    expect(probes.which('whisper-cli')).toBe(found('whisper-cli'))
    expect(nodeProbes().which('whisper-cli')).toBe(found('whisper-cli'))
    expect(execFileSync.mock.calls[0]![0]).toBe(isWindows ? 'where' : 'which')
    expect(probes.which('missing-cmd')).toBeNull()
    expect(probes.which('missing-cmd')).toBeNull()
    expect(execFileSync).toHaveBeenCalledTimes(2)
    vi.setSystemTime(1_000_000 + 31_000)
    probes.which('whisper-cli')
    expect(execFileSync).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
