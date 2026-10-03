import { describe, expect, it, vi } from 'vitest'
import { emulationKind } from '../../src/main/emulation'

const reportPerf = vi.fn()
vi.mock('@shared/report', () => ({ reportPerf }))
vi.mock('@shared/telemetry', () => ({ SLOW_STARTUP_MS: -1 }))

/** エミュレーション（Rosetta / Prism）で動いているかを、性能の報告のタグに付ける（FERRET-K） */
describe('エミュレーションの判定', () => {
  it('macOS は Rosetta、Windows は Prism。変換されていなければ none', () => {
    expect(emulationKind('darwin', true)).toBe('rosetta')
    expect(emulationKind('win32', true)).toBe('prism')
    expect(emulationKind('darwin', false)).toBe('none')
    expect(emulationKind('win32', undefined)).toBe('none')
    expect(emulationKind('linux', true)).toBe('none')
  })

  it('起動が遅いときの報告に、渡したタグを付ける', async () => {
    const { reportInteractive, setStartupTags } = await import('../../src/main/startup')
    setStartupTags({ emulation: 'prism' })
    reportInteractive()
    expect(reportPerf).toHaveBeenCalledWith('slow-startup', expect.any(Number), {
      tags: expect.objectContaining({ emulation: 'prism', 'startup.phase': expect.any(String) }),
      context: expect.objectContaining({ total: expect.any(String), pre_js: expect.any(String), js: expect.any(String) })
    })
  })
})
