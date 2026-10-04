import { describe, expect, it, vi } from 'vitest'
import { markOnce, reportInteractive } from '../../src/main/startup'

describe('起動の節目', () => {
  it('markOnce は最初の1回だけ記録する（renderer:firstIpc など、何度も通る場所の最初）', () => {
    vi.useFakeTimers({ now: Date.now() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      markOnce('renderer:firstIpc')
      const first = reportInteractive().marks['renderer:firstIpc']
      vi.advanceTimersByTime(500)
      markOnce('renderer:firstIpc')
      expect(reportInteractive().marks['renderer:firstIpc']).toBe(first)
    } finally {
      log.mockRestore()
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})
