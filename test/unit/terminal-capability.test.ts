/**
 * security-2 [6]: ターミナルに渡した中継の合言葉は、起動の失敗・明示的に閉じた・終了したときにすぐ無効にする。
 * node-pty は差し替え（本物のシェルは起動しない）。pid は実在しない値にして、kill がほかのプロセスに届かないようにする
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

type ExitListener = (e: { exitCode: number }) => void
const ptys: Array<{ exit: ExitListener | null }> = []
let spawnFails = false
vi.mock('node-pty', () => ({
  spawn: () => {
    if (spawnFails) throw new Error('spawn failed')
    const entry = { exit: null as ExitListener | null }
    ptys.push(entry)
    return {
      // macOS・Linux の PID の上限より大きい、実在しない値
      pid: 4_000_000 + ptys.length,
      onData: () => ({ dispose: () => {} }),
      onExit: (fn: ExitListener) => { entry.exit = fn; return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: () => {}
    }
  }
}))

const { TerminalManager } = await import('../../src/main/terminal')

describe('security-2 [6] ターミナルの合言葉の失効', () => {
  let closed: string[]
  let issued: string[]
  let manager: InstanceType<typeof TerminalManager>
  beforeEach(() => {
    closed = []
    issued = []
    spawnFails = false
    ptys.length = 0
    manager = new TerminalManager(() => {}, () => {})
    manager.launchEnv = async ({ sessionId }) => { issued.push(sessionId); return { FERRET_DECISION_URL: `http://127.0.0.1:1/v1/systemone?t=${sessionId}` } }
    manager.onSessionClosed = (id) => closed.push(id)
  })

  it('合言葉はタブの ID に結び付けて発行する', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    expect(issued).toEqual([tab.id])
  })

  it('起動に失敗したら、そのタブの合言葉を無効にする', async () => {
    spawnFails = true
    await expect(manager.create({ size: { cols: 80, rows: 24 } })).rejects.toThrow()
    expect(issued).toHaveLength(1)
    expect(closed).toEqual(issued)
  })

  it('明示的に閉じたら、終了の通知を待たずに無効にする', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    manager.close(tab.id)
    expect(closed).toEqual([tab.id])
  })

  it('シェルが終了したら無効にする', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    ptys[0]!.exit!({ exitCode: 0 })
    expect(closed).toEqual([tab.id])
  })
})
