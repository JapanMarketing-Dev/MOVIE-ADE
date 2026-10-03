import { expect, it } from 'vitest'
import { cursorRing } from '../../src/main/pipeline/cursor-ring'
it('元画像を保ち、範囲内のリングだけを白縁と赤で描画する', () => {
  const original = Buffer.alloc(100 * 100 * 4, 20)
  const ring = cursorRing(original, 100, 100, 50, 50)
  expect(original[0]).toBe(20)
  expect(ring.subarray((50 * 100 + 50) * 4, (50 * 100 + 50) * 4 + 4)).toEqual(Buffer.alloc(4, 20))
  expect(ring.subarray((50 * 100 + 62) * 4, (50 * 100 + 62) * 4 + 4)).toEqual(Buffer.from([48, 59, 255, 255]))
  expect(cursorRing(original, 100, 100, 0, 0)).toHaveLength(original.length)
})
