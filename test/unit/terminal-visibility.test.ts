/**
 * 画面に出ていないターミナルの出力をゆっくりまとめる（src/main/terminal.ts の setVisible・flushDelayMs）と、
 * Agent の状態のまとめた問い合わせ（agentStates）。
 * node-pty は差し替え（本物のシェルは起動しない）。pid は実在しない値にして、kill がほかのプロセスに届かないようにする
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

type DataListener = (data: string) => void
interface FakePty { data: DataListener | null }
const ptys: FakePty[] = []
vi.mock('node-pty', () => ({
  spawn: () => {
    const entry: FakePty = { data: null }
    ptys.push(entry)
    return {
      pid: 4_200_000 + ptys.length,
      onData: (fn: DataListener) => { entry.data = fn; return { dispose: () => {} } },
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {}
    }
  }
}))

const { TerminalManager, FLUSH_INTERVAL_MS, HIDDEN_FLUSH_INTERVAL_MS, MAX_CHUNK, flushDelayMs } = await import('../../src/main/terminal')

describe('flushDelayMs（次のフラッシュまでの待ち）', () => {
  it('見えているターミナルは毎フレーム、裏のターミナルはゆっくり', () => {
    expect(flushDelayMs(false, 10)).toBe(FLUSH_INTERVAL_MS)
    expect(flushDelayMs(true, 10)).toBe(HIDDEN_FLUSH_INTERVAL_MS)
    expect(HIDDEN_FLUSH_INTERVAL_MS).toBeGreaterThan(FLUSH_INTERVAL_MS)
  })

  it('裏でも 1 回で送る上限までたまっていれば待たない（古い出力を捨てない）', () => {
    expect(flushDelayMs(true, MAX_CHUNK - 1)).toBe(HIDDEN_FLUSH_INTERVAL_MS)
    expect(flushDelayMs(true, MAX_CHUNK)).toBe(FLUSH_INTERVAL_MS)
  })
})

describe('TerminalManager の表示の状態（terminal:visible）', () => {
  let sent: Array<[string, string]>
  let manager: InstanceType<typeof TerminalManager>
  beforeEach(() => {
    vi.useFakeTimers()
    ptys.length = 0
    sent = []
    manager = new TerminalManager((id, data) => { sent.push([id, data]) }, () => {})
  })
  const textOf = (id: string) => sent.filter(([to]) => to === id).map(([, data]) => data).join('')

  it('知らせる前に開いたターミナルは、見えているものとして毎フレーム送る', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    ptys[0].data?.('hello')
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(textOf(tab.id)).toBe('hello')
  })

  it('裏のターミナルはゆっくりまとめ、見えるようになったらためた分をすぐ送る', async () => {
    const shown = await manager.create({ size: { cols: 80, rows: 24 } })
    const hidden = await manager.create({ size: { cols: 80, rows: 24 } })
    manager.setVisible([shown.id])
    ptys[0].data?.('a')
    ptys[1].data?.('b1')
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(textOf(shown.id)).toBe('a')
    expect(textOf(hidden.id)).toBe('')
    ptys[1].data?.('b2')
    // 見えるようになった：タイマーを待たずに、順番どおりに送る
    manager.setVisible([shown.id, hidden.id])
    expect(textOf(hidden.id)).toBe('b1b2')
    ptys[1].data?.('b3')
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(textOf(hidden.id)).toBe('b1b2b3')
  })

  it('裏のターミナルも出力は失わず、順番も変わらない', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    manager.setVisible([])
    let expected = ''
    for (let i = 0; i < 50; i++) {
      const chunk = `line ${i}\n`
      expected += chunk
      ptys[0].data?.(chunk)
      await vi.advanceTimersByTimeAsync(37)
    }
    await vi.advanceTimersByTimeAsync(HIDDEN_FLUSH_INTERVAL_MS)
    expect(textOf(tab.id)).toBe(expected)
    // 毎フレームではなく、まとめて送っている
    expect(sent.length).toBeLessThan(15)
  })

  it('裏で大量に出力しても（上限の MAX_BUFFER を超える量でも）捨てずに送る', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    manager.setVisible([])
    const chunk = 'y'.repeat(64 * 1024)
    let total = 0
    // 5 MiB を、送る間隔を待たずに一気に流す
    for (let i = 0; i < 80; i++) {
      ptys[0].data?.(chunk)
      total += chunk.length
    }
    await vi.advanceTimersByTimeAsync(2000)
    expect(textOf(tab.id).length).toBe(total)
  })

  it('画面を読み込み直したら（resetFlow）前の画面の表示の状態を忘れる', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    manager.setVisible([])
    manager.resetFlow()
    ptys[0].data?.('z')
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(textOf(tab.id)).toBe('z')
  })
})

describe('agentStates（まとめた問い合わせ）', () => {
  it('ids と同じ順に返す。知らない id は unknown', async () => {
    const manager = new TerminalManager(() => {}, () => {})
    const spy = vi.spyOn(manager, 'agentState').mockImplementation(async (id: string) => ({
      kind: id === 't1' ? 'claude-code' : 'unknown', state: id === 't1' ? 'working' : 'unknown', agent: id === 't1' ? 'claude' : null
    }))
    const result = await manager.agentStates(['t1', 'nope'])
    expect(result.map((r) => r.state)).toEqual(['working', 'unknown'])
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
