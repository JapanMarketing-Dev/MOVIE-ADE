/**
 * マイクの名前（src/renderer/lib/micDevice.ts）。一覧がまだ読み込み中（null）でも落ちない
 */
import { describe, expect, it } from 'vitest'
import { micDeviceName } from '../../src/renderer/lib/micDevice'

describe('マイクの名前', () => {
  it('一覧がまだ無ければ null（起動直後にフィードバックの画面を開いたとき）', () => {
    expect(micDeviceName('', null)).toBeNull()
    expect(micDeviceName('x', undefined)).toBeNull()
  })
  it('選んだものの名前、無ければ既定の名前から前置きを外す', () => {
    expect(micDeviceName('a', [{ id: 'a', label: 'USB Mic' }])).toBe('USB Mic')
    expect(micDeviceName('', [{ id: 'default', label: 'Default - MacBook Mic' }])).toBe('MacBook Mic')
  })
})
