import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Windows の資源の監視が失敗したときの扱い（FERRET-Y）。
 * x64 版を ARM64 の Windows でエミュレーションして動かすと、PowerShell の CIM が時間切れになることがある。
 * 環境による失敗なので、種類だけを1回の起動で1度だけ送り、間を空けて再試行し、続けば止める。
 */
const reportHandled = vi.fn()
vi.mock('@shared/report', () => ({ reportHandled }))
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
const { WindowsProcessCollector, execFailureKind, resetReportedProbeFailuresForTest } = await import('../../src/main/resourcesWindows')

const COMMAND_FAILED = 'Command failed: powershell.exe -NoLogo -NoProfile -NonInteractive -Command Get-CimInstance Win32_Process ...'
const timeoutError = () => Object.assign(new Error(COMMAND_FAILED), { killed: true, signal: 'SIGTERM', code: null })
const TYPEPERF = ['"(PDH-CSV 4.0)","\\\\PC\\Process(code)\\ID Process","\\\\PC\\Process(code)\\Creating Process ID","\\\\PC\\Process(code)\\Working Set"', '"x","1234","1000","52428800"'].join('\r\n')

beforeEach(() => {
  reportHandled.mockClear()
  resetReportedProbeFailuresForTest()
})

describe('子プロセスの失敗の種類', () => {
  it('時間切れ・見つからない・終了コード・出力が大きすぎるを見分ける', () => {
    expect(execFailureKind(timeoutError())).toBe('timeout')
    expect(execFailureKind(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('not-found')
    expect(execFailureKind(Object.assign(new Error('x'), { code: 1, killed: false }))).toBe('exit')
    expect(execFailureKind(Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))).toBe('output-too-large')
    expect(execFailureKind(Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL' }))).toBe('killed')
    expect(execFailureKind('weird')).toBe('other')
  })
})

describe('CIM が時間切れになる環境', () => {
  it('種類だけを1回だけ送り、コマンドの全文は送らない。typeperf に切り替えて行は出す', async () => {
    const exec = vi.fn(async (file: string, _args: string[], _options?: { timeoutMs?: number }) => {
      if (file === 'powershell.exe') throw timeoutError()
      return TYPEPERF
    })
    let t = 0
    const collector = new WindowsProcessCollector(exec, () => t, 8)
    expect(await collector.enumerate()).toEqual([{ pid: 1234, ppid: 1000, cpu: 0, memory: 52428800 }])
    // 再試行の時刻を過ぎて、もう一度 CIM が時間切れになっても、同じ種類は送らない
    t += 31_000
    await collector.enumerate()
    expect(reportHandled).toHaveBeenCalledTimes(1)
    const [error, where] = reportHandled.mock.calls[0]!
    expect(error.message).toBe('powershell process sampling failed: timeout')
    expect(error.message).not.toContain('Get-CimInstance')
    expect(where).toEqual({ area: 'resources', op: 'sample processes with powershell' })
    // CIM には長めの時間切れを渡す（エミュレーションでの PowerShell の起動は遅い）
    expect(exec.mock.calls[0]![2]).toEqual({ timeoutMs: 15_000 })
  })

  it('続けて失敗するたびに再試行の間を倍にし、4回でやめて typeperf だけにする', async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === 'powershell.exe') throw timeoutError()
      return TYPEPERF
    })
    let t = 0
    const collector = new WindowsProcessCollector(exec, () => t, 8)
    const cimCalls = () => exec.mock.calls.filter(([file]) => file === 'powershell.exe').length
    await collector.enumerate() // 1回目の失敗 → 30秒後
    t += 29_000
    await collector.enumerate()
    expect(cimCalls()).toBe(1)
    t += 2_000
    await collector.enumerate() // 2回目の失敗 → 60秒後
    t += 59_000
    await collector.enumerate()
    expect(cimCalls()).toBe(2)
    t += 2_000
    await collector.enumerate() // 3回目 → 120秒後
    t += 121_000
    await collector.enumerate() // 4回目でやめる
    expect(cimCalls()).toBe(4)
    t += 3_600_000
    await collector.enumerate()
    expect(cimCalls()).toBe(4)
  })

  it('typeperf も続けて失敗したら取得をやめ、空の一覧を返す', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: typeperf.exe ...'), { code: 1, killed: false })
    })
    let t = 0
    const collector = new WindowsProcessCollector(exec, () => t, 8)
    for (let i = 0; i < 12; i++) {
      expect(await collector.enumerate()).toEqual([])
      t += 11 * 60_000
    }
    expect(collector.stopped).toBe(true)
    const calls = exec.mock.calls.length
    await collector.enumerate()
    expect(exec.mock.calls.length).toBe(calls)
    // 送ったのは powershell / typeperf の種類ごとに1件ずつ
    expect(reportHandled.mock.calls.map(([e]) => e.message)).toEqual(['powershell process sampling failed: exit', 'typeperf process sampling failed: exit'])
  })
})
