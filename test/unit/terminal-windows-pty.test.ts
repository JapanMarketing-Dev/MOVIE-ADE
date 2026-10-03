import { describe, expect, it } from 'vitest'
import { windowsPtyOption } from '../../src/renderer/terminal/windowsPty'

describe('windowsPtyOption', () => {
  it('Windows だけ ConPTY とビルド番号を渡す', () => {
    expect(windowsPtyOption('win32', '10.0.22631')).toEqual({ backend: 'conpty', buildNumber: 22631 })
    expect(windowsPtyOption('win32', '10.0.19045')).toEqual({ backend: 'conpty', buildNumber: 19045 })
    expect(windowsPtyOption('win32', undefined)).toEqual({ backend: 'conpty' })
    expect(windowsPtyOption('darwin', '25.6.0')).toBeUndefined()
    expect(windowsPtyOption('linux', '6.8.0')).toBeUndefined()
  })
})
