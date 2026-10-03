import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSlowOps, noteSlowOp, recentSlowOps, reportPerf, setReporter, timedSync, type Reporter } from '../../src/shared/report'
import {
  createBreadcrumbFilter,
  createInflightTracker,
  DEV_EVENT_LOOP_BLOCK_MS,
  EVENT_LOOP_BLOCK_MS,
  eventLoopBlockContext,
  eventLoopBlockThreshold,
  scrubEvent
} from '../../src/shared/telemetry'

/**
 * main の停止（Main event loop blocked）の手がかりと、パンくずの間引き。
 */

afterEach(() => {
  setReporter(null)
  clearSlowOps()
})

describe('止まったときの手がかり', () => {
  it('処理中の IPC は長い順の上位3つ。終わったものは外れる', () => {
    let now = 0
    const t = createInflightTracker(() => now)
    const endA = t.begin('review:list')
    now = 100
    t.begin('capture:availability')
    now = 300
    const endC = t.begin('fs:read')
    t.begin('terminal:cwd')
    now = 1300
    expect(endC()).toBe(1000)
    expect(t.snapshot()).toEqual([
      { name: 'review:list', ms: 1300 }, { name: 'capture:availability', ms: 1200 }, { name: 'terminal:cwd', ms: 1000 }
    ])
    endA()
    expect(t.snapshot()[0]!.name).toBe('capture:availability')
  })

  it('重い同期の処理（100ms 以上）だけを控え、パンくずにも名前と時間だけを残す', () => {
    const breadcrumb = vi.fn<Reporter['breadcrumb']>()
    setReporter({ handled: vi.fn(), message: vi.fn(), breadcrumb })
    noteSlowOp('which:whisper-cli', 40, 1000)
    noteSlowOp('ps', 450, 1000)
    noteSlowOp('settings:save', 120, 1000)
    expect(recentSlowOps(2000)).toEqual([{ op: 'ps', ms: 450 }, { op: 'settings:save', ms: 120 }])
    expect(breadcrumb).toHaveBeenCalledWith('slow op', { op: 'ps', ms: 450 })
    // 10秒より前のものは手がかりにしない
    expect(recentSlowOps(20_000)).toEqual([])
  })

  it('timedSync は値を返し、例外でも時間を控える', () => {
    expect(timedSync('quick', () => 42)).toBe(42)
    expect(() => timedSync('boom', () => { throw new Error('x') })).toThrow('x')
  })

  it('止まったイベントにはタグと contexts.block で手がかりを付け、送る前の除去で消えない', () => {
    const ctx = eventLoopBlockContext([{ name: 'review:list', ms: 2100 }, { name: 'fs:read', ms: 300 }], [{ op: 'which:whisper-cli', ms: 1800 }])
    expect(ctx.tags).toEqual({ 'block.ipc': 'review:list', 'block.slowop': 'which:whisper-cli' })
    expect(ctx.context).toEqual({ inflight_ipc: 'review:list 2100ms, fs:read 300ms', recent_slow_ops: 'which:whisper-cli 1800ms' })
    expect(eventLoopBlockContext([], []).tags).toEqual({ 'block.ipc': 'none', 'block.slowop': 'none' })
    const out = scrubEvent({ contexts: { block: ctx.context } }) as { contexts: Record<string, unknown> }
    expect(out.contexts.block).toEqual(ctx.context)
  })

  it('reportPerf は手がかりをタグと contexts で送り、まとめ方（fingerprint）は種類のまま', () => {
    const message = vi.fn<Reporter['message']>()
    setReporter({ handled: vi.fn(), breadcrumb: vi.fn(), message })
    const ctx = eventLoopBlockContext([{ name: 'review:list', ms: 2100 }], [])
    reportPerf('event-loop-block', 2000, ctx)
    expect(message).toHaveBeenCalledWith('Main event loop blocked (2.0s)',
      { kind: 'perf', perf: 'event-loop-block', duration: '2-5s', 'block.ipc': 'review:list', 'block.slowop': 'none' },
      'warning', ['anomaly', 'event-loop-block'], { block: ctx.context })
  })

  it('閾値：配布版は1秒のまま、開発版は3秒', () => {
    expect(eventLoopBlockThreshold(true)).toBe(EVENT_LOOP_BLOCK_MS)
    expect(EVENT_LOOP_BLOCK_MS).toBe(1000)
    expect(eventLoopBlockThreshold(false)).toBe(DEV_EVENT_LOOP_BLOCK_MS)
    expect(DEV_EVENT_LOOP_BLOCK_MS).toBe(3000)
  })
})

describe('パンくずの間引き', () => {
  it('補助技術の切り替えの通知は捨て、同じものの連続は1つにする', () => {
    const keep = createBreadcrumbFilter()
    const a11y = { category: 'electron', message: 'app.accessibility-support-changed' }
    expect(keep(a11y)).toBe(false)
    expect(keep({ category: 'electron', message: 'app.browser-window-focus' })).toBe(true)
    expect(keep({ category: 'electron', message: 'app.browser-window-focus' })).toBe(false)
    expect(keep(a11y)).toBe(false)
    expect(keep({ category: 'flow', message: 'settings save' })).toBe(true)
    expect(keep({ category: 'electron', message: 'app.browser-window-focus' })).toBe(true)
  })
})
