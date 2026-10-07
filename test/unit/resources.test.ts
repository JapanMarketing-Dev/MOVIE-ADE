import { describe, expect, it, vi } from 'vitest'
import { formatCpu, formatMemory } from '@shared/resources'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
const { collectSubtree, indexProcesses, parsePsOutput, projectForCwd, topProcess } = await import('../../src/main/resources')

const PS = `
    1     0   0.0   1024
  100     1   2.5   2048
  101   100  10,0   4096
  102   101   1.5   8192
  200     1   0.0    512
  bad line
`

describe('parsePsOutput', () => {
  it('pid・ppid・CPU・RSS(KB→バイト) を読み、壊れた行は飛ばす', () => {
    const rows = parsePsOutput(PS)
    expect(rows).toHaveLength(5)
    expect(rows[1]).toEqual({ pid: 100, ppid: 1, cpu: 2.5, memory: 2048 * 1024 })
    // 「,」区切りの CPU は小数部を落とす（実際は C ロケールで実行するので出ない）
    expect(rows[2].cpu).toBe(10)
  })
})

describe('parsePsOutput の comm', () => {
  it('5列目以降を実行ファイルの名前として読む（空白入り・パスは最後の部分）', () => {
    const rows = parsePsOutput(`  10 1 3.0 100 /Applications/Ferret.app/Contents/Frameworks/Ferret Helper (Renderer).app/Contents/MacOS/Ferret Helper (Renderer)\n  11 10 185.4 200 /tmp/venv/bin/python\n`)
    expect(rows.map((r) => r.name)).toEqual(['Ferret Helper (Renderer)', 'python'])
  })
})

describe('topProcess', () => {
  // Claude Code（ターミナルの子）が起動した python が CPU のほとんどを使っている形（リソースマネージャで 202% と出た例）
  const index = indexProcesses(parsePsOutput(`  1 0 0 1 zsh\n  2 1 3.3 1 claude\n  3 2 185.4 1 python\n  4 2 0.5 1 node\n`))
  it('シェル自身を除いて、一番 CPU を使っているプロセスを返す', () => {
    expect(topProcess(index, [1, 2, 3, 4], 1)).toEqual({ name: 'python', cpu: 185.4 })
  })
  it('10% に満たなければ出さない', () => {
    expect(topProcess(index, [1, 2, 4], 1)).toBeNull()
  })
})

describe('collectSubtree', () => {
  const index = indexProcesses(parsePsOutput(PS))
  it('根から子孫をすべて辿る', () => {
    expect(collectSubtree(index, 100).sort()).toEqual([100, 101, 102])
  })
  it('別のターミナルが数えたPIDは辿らない（二重に数えない）', () => {
    expect(collectSubtree(index, 100, new Set([101]))).toEqual([100])
  })
  it('居ないPIDは空', () => {
    expect(collectSubtree(index, 999)).toEqual([])
  })
})

describe('projectForCwd', () => {
  const projects = [
    { id: 'a', name: 'A', folderPath: '/work/app', urls: [] },
    { id: 'b', name: 'B', folderPath: '/work/app/packages/web/', urls: [] }
  ]
  it('一番深いフォルダのプロジェクトを選ぶ', () => {
    expect(projectForCwd('/work/app/src', projects)?.id).toBe('a')
    expect(projectForCwd('/work/app/packages/web/src', projects)?.id).toBe('b')
    expect(projectForCwd('/work/app', projects)?.id).toBe('a')
  })
  it('名前の前方一致だけのフォルダは別物', () => {
    expect(projectForCwd('/work/application', projects)).toBeNull()
    expect(projectForCwd('/Users/me', projects)).toBeNull()
  })
})

describe('formatMemory / formatCpu', () => {
  it('KB・MB・GB で出す', () => {
    expect(formatMemory(512 * 1024)).toBe('512 KB')
    expect(formatMemory(300 * 1024 * 1024)).toBe('300.0 MB')
    expect(formatMemory(1.22 * 1024 ** 3)).toBe('1.22 GB')
    expect(formatCpu(12.345)).toBe('12.3%')
  })
})

describe('ps の失敗を送るか（FERRET-1M）', () => {
  it('一時的な失敗は送らず、続けて3回目だけ送る。時間切れで止めたものは送らない', async () => {
    const { shouldReportPsFailure } = await import('../../src/main/resources')
    const err = new Error('ps failed')
    expect(shouldReportPsFailure(err, 1)).toBe(false)
    expect(shouldReportPsFailure(err, 2)).toBe(false)
    expect(shouldReportPsFailure(err, 3)).toBe(true)
    expect(shouldReportPsFailure(err, 4)).toBe(false)
    expect(shouldReportPsFailure(Object.assign(new Error('timeout'), { killed: true }), 3)).toBe(false)
  })
})
