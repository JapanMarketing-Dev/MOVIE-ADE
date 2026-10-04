import { describe, expect, it } from 'vitest'
import { CRASH_RELOAD_LIMIT, CRASH_RELOAD_WINDOW_MS, allowCrashReload } from '../../src/main/crashReload'

describe('画面のプロセスが落ちたときの読み込み直し（Orca #7742 #8260 #14549）', () => {
  it('落ちたら読み込み直す。正常な終了では読み込まない', () => {
    const history: number[] = []
    expect(allowCrashReload(history, 'crashed', 0)).toBe(true)
    expect(allowCrashReload(history, 'clean-exit', 1)).toBe(false)
    expect(history).toEqual([0])
  })

  it('1分に3回までにして、読み込むたびに落ちるときに繰り返さない', () => {
    const history: number[] = []
    for (let i = 0; i < CRASH_RELOAD_LIMIT; i++) expect(allowCrashReload(history, 'oom', i * 1000)).toBe(true)
    expect(allowCrashReload(history, 'crashed', 5000)).toBe(false)
    // 1分たてば、また読み込み直す
    expect(allowCrashReload(history, 'crashed', CRASH_RELOAD_WINDOW_MS + 1)).toBe(true)
  })
})
