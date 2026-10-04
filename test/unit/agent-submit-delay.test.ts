import { describe, expect, it } from 'vitest'
import { submitDelayFor } from '../../src/main/agent/send'

describe('貼り付けから Enter までの待ち（Orca #16680）', () => {
  it('短い本文は今までどおり 50ms', () => {
    expect(submitDelayFor(10, 'darwin')).toBe(50)
    expect(submitDelayFor(0, 'linux')).toBe(50)
  })

  it('長い本文ほど待つ。Windows（ConPTY）はより長く', () => {
    expect(submitDelayFor(8192, 'darwin')).toBe(52)
    expect(submitDelayFor(8192, 'win32')).toBe(178)
  })

  it('上限は 3 秒', () => {
    expect(submitDelayFor(10_000_000, 'win32')).toBe(3000)
  })
})
