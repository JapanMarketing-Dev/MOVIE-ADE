import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
const { WindowsProcessCollector, parseTypeperfProcessOutput, parseWindowsProcessSample } = await import('../../src/main/resourcesWindows')
const { ResourceCollector } = await import('../../src/main/resources')

// pid ⇥ ppid ⇥ WorkingSet ⇥ KernelTime ⇥ UserTime ⇥ 起動時刻（100ns 単位）
const cim = (kernel: number, user: number) => [
  `100\t4\t2048000\t${kernel}\t${user}\t638000000000000000`,
  '200\t100\t1024\t\t\t638000000000000001', // CPU時間が空（null）の行
  '0\t0\t0\t0\t0\t0', // System Idle（pid 0）は飛ばす
  'garbage'
].join('\r\n')

const TYPEPERF = [
  '"(PDH-CSV 4.0)","\\\\PC\\Process(code)\\ID Process","\\\\PC\\Process(code)\\Creating Process ID","\\\\PC\\Process(code)\\Working Set","\\\\PC\\Process(_Total)\\ID Process"',
  '"10/03/2026 10:00:00.000","1234","1000","52428800","0"'
].join('\r\n')

describe('parseWindowsProcessSample（CIM）', () => {
  it('タブ区切りの行を読み、空の項目で列がずれない', () => {
    const sample = parseWindowsProcessSample(cim(10_000_000, 5_000_000))
    expect(sample.rows).toEqual([
      { pid: 100, ppid: 4, cpu: 0, memory: 2048000 },
      { pid: 200, ppid: 100, cpu: 0, memory: 1024 }
    ])
    expect(sample.cpuByPid.get(100)?.cpuTicks).toBe(15_000_000n)
    expect(sample.cpuByPid.has(200)).toBe(false)
  })
})

describe('parseTypeperfProcessOutput', () => {
  it('見出しのカウンター名で値を拾い、_Total は除く', () => {
    expect(parseTypeperfProcessOutput(TYPEPERF)).toEqual([{ pid: 1234, ppid: 1000, cpu: 0, memory: 52428800 }])
  })
  it('見出しが無ければ空', () => {
    expect(parseTypeperfProcessOutput('nothing')).toEqual([])
  })
})

describe('WindowsProcessCollector', () => {
  it('累積CPU時間の差から CPU% を出す（初回は 0）', async () => {
    let t = 0
    let kernel = 0
    const exec = vi.fn(async () => cim(kernel, 0))
    const collector = new WindowsProcessCollector(exec, () => t, 8)
    expect((await collector.enumerate())[0].cpu).toBe(0)
    // 1秒で 0.5秒ぶんのCPU時間 → 50%
    t = 1000
    kernel = 5_000_000
    expect((await collector.enumerate())[0].cpu).toBeCloseTo(50)
  })

  it('CIM が失敗したら typeperf に切り替え、30秒は CIM を試さない', async () => {
    let t = 0
    const exec = vi.fn(async (file: string) => {
      if (file === 'powershell.exe') throw new Error('blocked')
      return TYPEPERF
    })
    const collector = new WindowsProcessCollector(exec, () => t, 8)
    expect(await collector.enumerate()).toHaveLength(1)
    t = 10_000
    await collector.enumerate()
    expect(exec.mock.calls.filter(([f]) => f === 'powershell.exe')).toHaveLength(1)
    t = 31_000
    await collector.enumerate()
    expect(exec.mock.calls.filter(([f]) => f === 'powershell.exe')).toHaveLength(2)
  })
})

describe('ResourceCollector の OS 切り替え', () => {
  it('win32 では Windows の係でターミナルのプロセスツリーを数える', async () => {
    const exec = vi.fn(async () => cim(0, 0))
    const collector = new ResourceCollector({
      terminals: () => [{ id: 't1', pid: 100, cwd: 'C:\\work', title: 'シェル' }],
      projects: () => [],
      activeProjectId: () => null,
      page: () => null
    }, 'win32', new WindowsProcessCollector(exec, () => 0, 8))
    const snap = await collector.collect()
    expect(exec).toHaveBeenCalled()
    expect(snap.terminalCount).toBe(1)
    // 子プロセス（pid 200）が居るので「実行中」、RSS は親子の合計
    expect(snap.projects[0].terminals[0]).toMatchObject({ running: true, memory: 2048000 + 1024 })
  })
})
