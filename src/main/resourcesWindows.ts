import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { ProcRow } from './resources'

/**
 * Windows のプロセス一覧（pid・ppid・CPU・RSS）。Windows には ps が無いので、
 * PowerShell の Get-CimInstance Win32_Process で取り、失敗したら typeperf に切り替える。
 *
 * Orca由来: ~/bench/orca/src/main/memory/windows-process-resource-collector.ts,
 *           ~/bench/orca/src/main/memory/windows-process-sample-parsing.ts（MIT）。
 * CIM の行・typeperf の CSV の読み取りと、累積CPU時間の差分からCPU%を出す処理を移植した。
 * Orca が併せて取っている commit（PageFileUsage / Private Bytes）は使わないので外した。
 * 読み取りは純粋関数、取得は実行関数と時計を外から渡せる形にして、単体テストから使う。
 */

const QUERY_TIMEOUT_MS = 5000
const QUERY_MAX_BUFFER = 10 * 1024 * 1024
const CPU_MIN_SAMPLE_MS = 250
const CPU_STALE_AFTER_MS = 10_000
const HUNDRED_NS_TICKS_PER_MS = 10_000
const CIM_RETRY_AFTER_MS = 30_000
const MAX_LINE_CHARS = 1024 * 1024

export const TYPEPERF_COUNTERS = [
  '\\Process(*)\\ID Process',
  '\\Process(*)\\Creating Process ID',
  '\\Process(*)\\Working Set'
] as const

const CIM_COMMAND =
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate | ' +
  'ForEach-Object { try { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, [string]$_.KernelModeTime, [string]$_.UserModeTime, $_.CreationDate.ToUniversalTime().Ticks)) } catch {} }'

export interface WindowsCpuTimes {
  /** カーネル＋ユーザーの累積CPU時間（100ns 単位） */
  cpuTicks: bigint
  /** 起動時刻。PIDの使い回しで別プロセスの累積時間を引き継がないための印 */
  startTimeId: string
}

export interface WindowsProcessSample {
  rows: ProcRow[]
  cpuByPid: Map<number, WindowsCpuTimes>
}

function parseUnsignedBigInt(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

/** CIM の行（pid ⇥ ppid ⇥ WorkingSet ⇥ KernelTime ⇥ UserTime ⇥ 起動時刻）を読む。CPU はまだ 0 */
export function parseWindowsProcessSample(stdout: string): WindowsProcessSample {
  const rows: ProcRow[] = []
  const cpuByPid = new Map<number, WindowsCpuTimes>()
  for (const line of stdout.split(/\r?\n/)) {
    // null の項目は空のタブになる。空白で詰めると列がずれるので、タブでだけ区切る
    if (line.length > MAX_LINE_CHARS) continue
    const fields = line.split('\t', 6).map((f) => f.trim())
    if (fields.length < 3) continue
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const memory = Number.parseInt(fields[2], 10)
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue
    rows.push({ pid, ppid, cpu: 0, memory: Number.isFinite(memory) && memory > 0 ? memory : 0 })
    const kernel = parseUnsignedBigInt(fields[3])
    const user = parseUnsignedBigInt(fields[4])
    const startTimeId = fields[5] ?? ''
    if (kernel !== null && user !== null && /^\d+$/.test(startTimeId) && !/^0+$/.test(startTimeId)) {
      cpuByPid.set(pid, { cpuTicks: kernel + user, startTimeId })
    }
  }
  return { rows, cpuByPid }
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (ch === ',' && !quoted) {
      fields.push(value)
      value = ''
    } else {
      value += ch
    }
  }
  fields.push(value)
  return fields
}

function parseCounterPath(path: string): { instance: string; counter: string } | null {
  const start = path.lastIndexOf('\\Process(')
  const end = path.lastIndexOf(')\\')
  if (start === -1 || end <= start + 9) return null
  return { instance: path.slice(start + 9, end), counter: path.slice(end + 2) }
}

/** typeperf の CSV（見出し行＋1回分の値）を読む。typeperf は CPU を出さないので 0 */
export function parseTypeperfProcessOutput(stdout: string): ProcRow[] {
  let headers: string[] | null = null
  let values: string[] | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || line.length > MAX_LINE_CHARS) continue
    const fields = parseCsvLine(line)
    if (!headers && fields[0]?.startsWith('(PDH-CSV')) {
      headers = fields
      continue
    }
    if (headers && fields.length === headers.length) {
      values = fields
      break
    }
  }
  if (!headers || !values) return []

  const byInstance = new Map<string, { pid?: number; ppid?: number; memory?: number }>()
  for (let i = 1; i < headers.length; i += 1) {
    const path = parseCounterPath(headers[i])
    if (!path || path.instance === '_Total') continue
    const value = Number.parseFloat(values[i])
    if (!Number.isFinite(value)) continue
    const row = byInstance.get(path.instance) ?? {}
    if (path.counter === 'ID Process') row.pid = Math.trunc(value)
    else if (path.counter === 'Creating Process ID') row.ppid = Math.trunc(value)
    else if (path.counter === 'Working Set') row.memory = value
    byInstance.set(path.instance, row)
  }
  const rows: ProcRow[] = []
  for (const row of byInstance.values()) {
    if (row.pid === undefined || row.pid <= 0 || row.ppid === undefined || row.ppid < 0) continue
    rows.push({ pid: row.pid, ppid: row.ppid, cpu: 0, memory: row.memory && row.memory > 0 ? row.memory : 0 })
  }
  return rows
}

/** 実行関数（コマンドと引数を受けて標準出力を返す）。単体テストでは差し替える */
export type ExecText = (file: string, args: string[]) => Promise<string>

const defaultExec: ExecText = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, { timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_MAX_BUFFER, windowsHide: true })
  return stdout
}

/**
 * Windows のプロセス一覧を取る係。CPU% は前回との累積CPU時間の差から出すので、前回の値を持つ。
 * CIM が失敗したら typeperf（メモリだけ）に切り替え、30秒後にまた CIM を試す。
 */
export class WindowsProcessCollector {
  private backend: 'cim' | 'typeperf' = 'cim'
  private previous: (WindowsProcessSample & { sampledAtMs: number }) | null = null
  private retryCimAtMs = 0

  constructor(
    private readonly exec: ExecText = defaultExec,
    private readonly now: () => number = () => performance.now(),
    private readonly cpuCount: number = Math.max(1, cpus().length)
  ) {}

  async enumerate(): Promise<ProcRow[]> {
    if (this.backend === 'typeperf') {
      if (this.now() < this.retryCimAtMs) return this.viaTypeperf()
      this.backend = 'cim'
    }
    const sample = await this.viaCim()
    if (sample) return this.applyCpu(sample)
    // CIM が詰まっているときに、毎回の取得でタイムアウトを待たない
    this.backend = 'typeperf'
    this.retryCimAtMs = this.now() + CIM_RETRY_AFTER_MS
    this.previous = null
    return this.viaTypeperf()
  }

  private async viaCim(): Promise<(WindowsProcessSample & { sampledAtMs: number }) | null> {
    try {
      const stdout = await this.exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CIM_COMMAND])
      const parsed = parseWindowsProcessSample(stdout)
      return parsed.rows.length > 0 ? { ...parsed, sampledAtMs: this.now() } : null
    } catch (err) {
      console.warn('[resources] PowerShell でプロセスを取れませんでした。typeperf に切り替えます', err)
      return null
    }
  }

  private async viaTypeperf(): Promise<ProcRow[]> {
    try {
      return parseTypeperfProcessOutput(await this.exec('typeperf.exe', [...TYPEPERF_COUNTERS, '-sc', '1', '-si', '0']))
    } catch (err) {
      console.warn('[resources] typeperf でプロセスを取れませんでした', err)
      return []
    }
  }

  private applyCpu(sample: WindowsProcessSample & { sampledAtMs: number }): ProcRow[] {
    const previous = this.previous
    if (!previous) {
      this.previous = sample
      return sample.rows
    }
    const elapsedMs = sample.sampledAtMs - previous.sampledAtMs
    // 間隔が短すぎると率がぶれるので、前回の基準を残して次の取得で測る
    if (elapsedMs < CPU_MIN_SAMPLE_MS) return sample.rows
    this.previous = sample
    // 閉じていた・スリープしていたなど間が空いた基準は、今のCPUを表さない
    if (elapsedMs > CPU_STALE_AFTER_MS) return sample.rows
    const maxCpu = this.cpuCount * 100
    for (const row of sample.rows) {
      const cur = sample.cpuByPid.get(row.pid)
      const prev = previous.cpuByPid.get(row.pid)
      if (!cur || !prev || cur.startTimeId !== prev.startTimeId || cur.cpuTicks < prev.cpuTicks) continue
      const cpuMs = Number(cur.cpuTicks - prev.cpuTicks) / HUNDRED_NS_TICKS_PER_MS
      row.cpu = Math.min(maxCpu, Math.max(0, (cpuMs / elapsedMs) * 100))
    }
    return sample.rows
  }
}
