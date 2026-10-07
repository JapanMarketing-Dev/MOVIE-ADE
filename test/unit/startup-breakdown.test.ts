import { describe, expect, it } from 'vitest'
import { MAX_STARTUP_MARKS, slowStartupReport, startupBreakdown, type StartupTiming } from '../../src/shared/startupBreakdown'
import { perfAnomalyEvent, scrubEvent } from '../../src/shared/telemetry'

/**
 * 起動の遅さを、JS より前（プロセスの生成からモジュールの読み込みまで）と後に分ける（FERRET-K）。
 * 0.3.0 の本番の例：生成 13:10:43.477 → 報告 44.916 のうち JS は約1.4秒、全体は 5〜10 秒
 */
const ORIGIN = 1_790_000_000_000
const timing = (over: Partial<StartupTiming> = {}): StartupTiming => ({
  totalMs: 7000, origin: ORIGIN, moduleLoadedAt: ORIGIN + 5600, originSource: 'process', marks: { 'app-ready': 5900, 'window-created': 6300, interactive: 7000 }, ...over
})

describe('startupBreakdown', () => {
  it('JS より前が大部分なら pre-js（内訳は名前と時間だけ）', () => {
    const b = startupBreakdown(timing())
    expect(b.preJsMs).toBe(5600)
    expect(b.jsMs).toBe(1400)
    expect(b.phase).toBe('pre-js')
    expect(b.tags).toEqual({ 'startup.phase': 'pre-js', 'startup.origin': 'process' })
    expect(b.context).toEqual({ total: '7000ms', pre_js: '5600ms', js: '1400ms', marks: 'app-ready=5900ms window-created=6300ms interactive=7000ms' })
  })

  it('境界：JS より前がちょうど半分なら js、半分を超えたら pre-js', () => {
    expect(startupBreakdown(timing({ totalMs: 6000, moduleLoadedAt: ORIGIN + 3000 })).phase).toBe('js')
    expect(startupBreakdown(timing({ totalMs: 6000, moduleLoadedAt: ORIGIN + 3001 })).phase).toBe('pre-js')
  })

  it('getCreationTime が無い（基準がモジュールの読み込み）ときは、JS より前は分からないとし全体を JS とみなす', () => {
    const b = startupBreakdown(timing({ originSource: 'module', origin: ORIGIN + 5600 }))
    expect(b.preJsMs).toBeNull()
    expect(b.jsMs).toBe(7000)
    expect(b.phase).toBe('unknown')
    expect(b.tags).toEqual({ 'startup.phase': 'unknown', 'startup.origin': 'module' })
    expect(b.context.pre_js).toBe('unknown')
  })

  it('時計のずれで負や全体超えになっても 0〜全体に収める', () => {
    expect(startupBreakdown(timing({ moduleLoadedAt: ORIGIN - 50 })).preJsMs).toBe(0)
    const over = startupBreakdown(timing({ moduleLoadedAt: ORIGIN + 9000 }))
    expect(over.preJsMs).toBe(7000)
    expect(over.jsMs).toBe(0)
  })

  it('節目は決まった形の名前だけを、時間の順に上限まで載せる', () => {
    const marks: Record<string, number> = { 'open /Users/someone/acme-shop': 10, 'https://example.com': 20, bad: Number.NaN, b: 30, a: 5 }
    for (let i = 0; i < MAX_STARTUP_MARKS + 5; i++) marks[`m${i}`] = 100 + i
    const b = startupBreakdown(timing({ marks }))
    const names = b.context.marks!.split(' ').map((x) => x.split('=')[0])
    expect(names.slice(0, 2)).toEqual(['a', 'b'])
    expect(names).toHaveLength(MAX_STARTUP_MARKS)
    expect(b.context.marks).not.toMatch(/Users|example|NaN/)
    expect(startupBreakdown(timing({ marks: {} })).context.marks).toBe('none')
  })

  it('伏せ字を通しても contexts.startup とタグが残る', () => {
    const b = startupBreakdown(timing())
    const out = scrubEvent({ tags: b.tags, contexts: { startup: b.context } }) as { tags: Record<string, string>; contexts: Record<string, unknown> }
    expect(out.tags['startup.phase']).toBe('pre-js')
    expect(out.contexts.startup).toEqual(b.context)
  })
})

describe('slowStartupReport', () => {
  const T = 5000
  it('JS より後が閾値を超えたときだけ slow-startup（時間は JS より後の分）', () => {
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 8000, moduleLoadedAt: ORIGIN + 2000 })), T)).toEqual({ perf: 'slow-startup', ms: 6000 })
  })

  it('JS より前の遅れで全体が超えたときは slow-pre-js に分ける（時間は全体）', () => {
    expect(slowStartupReport(startupBreakdown(timing()), T)).toEqual({ perf: 'slow-pre-js', ms: 7000 })
  })

  it('その版の初めての起動（入れた・更新した直後）は、JS より前の遅れを数えない。JS より後の遅れは数える', () => {
    expect(slowStartupReport(startupBreakdown(timing()), T, { firstLaunchOfVersion: true })).toBeNull()
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 8000, moduleLoadedAt: ORIGIN + 2000 })), T, { firstLaunchOfVersion: true })).toEqual({ perf: 'slow-startup', ms: 6000 })
  })

  it('境界：ちょうど閾値は報告しない', () => {
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 5000, moduleLoadedAt: ORIGIN })), T)).toBeNull()
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 5001, moduleLoadedAt: ORIGIN })), T)).toEqual({ perf: 'slow-startup', ms: 5001 })
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 5001, moduleLoadedAt: ORIGIN + 1 })), T)).toEqual({ perf: 'slow-pre-js', ms: 5001 })
  })

  it('getCreationTime が無いときは全体を JS とみなして slow-startup', () => {
    expect(slowStartupReport(startupBreakdown(timing({ originSource: 'module' })), T)).toEqual({ perf: 'slow-startup', ms: 7000 })
  })

  it('slow-pre-js は slow-startup と別の issue（題名と fingerprint）になる', () => {
    expect(perfAnomalyEvent('slow-pre-js', 7000)).toMatchObject({ message: 'Slow launch before JS (7.0s)', fingerprint: ['anomaly', 'slow-pre-js'] })
  })
})
