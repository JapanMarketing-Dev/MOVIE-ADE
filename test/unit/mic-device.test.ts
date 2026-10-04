import { describe, expect, it } from 'vitest'
import { micDeviceName } from '../../src/renderer/lib/micDevice'

describe('録画ツールバーに出すマイクの名前', () => {
  const devices = [
    { id: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' },
    { id: 'abc', label: 'USB Audio Device' }
  ]

  it('選んだマイクはその名前', () => {
    expect(micDeviceName('abc', devices)).toBe('USB Audio Device')
  })

  it('システムの既定なら、既定の機器の名前（前置きを外す）', () => {
    expect(micDeviceName('', devices)).toBe('MacBook Pro Microphone (Built-in)')
  })

  it('分からなければ null（抜いたマイク・一覧が空）', () => {
    expect(micDeviceName('gone', devices)).toBeNull()
    expect(micDeviceName('', [])).toBeNull()
  })
})
