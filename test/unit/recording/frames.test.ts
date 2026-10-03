import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAME_RATIO,
  frameFileName,
  hasChanged,
  targetWidth
} from '../../../src/main/recording/frames'

/** BGRAの縮小画素を作る。`paint` で一部の画素だけ色を変える */
function bitmap(pixels: number, fill = 0, paint: (i: number) => number | null = () => null): Uint8Array {
  const data = new Uint8Array(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    const value = paint(i) ?? fill
    data[i * 4] = value
    data[i * 4 + 1] = value
    data[i * 4 + 2] = value
    data[i * 4 + 3] = 255
  }
  return data
}

describe('静止画の重複判定（設計4章「画面が変化した時のみ保存」）', () => {
  it('前の画像が無ければ、必ず変化とみなす', () => {
    expect(hasChanged(null, bitmap(100))).toBe(true)
  })

  it('同じ画像なら変化とみなさない', () => {
    const image = bitmap(1000, 120)
    expect(hasChanged(image, bitmap(1000, 120))).toBe(false)
  })

  it('わずかな揺らぎ（アンチエイリアス程度）は変化とみなさない', () => {
    const before = bitmap(1000, 120)
    // 1画素あたり3成分で合計21の差。既定のしきい値24未満
    const after = bitmap(1000, 127)
    expect(hasChanged(before, after)).toBe(false)
  })

  it('画面の一部でもはっきり変われば変化とみなす', () => {
    const before = bitmap(1000, 120)
    // 2%の画素を大きく変える（既定の 1.2% を超える）
    const after = bitmap(1000, 120, (i) => (i < 20 ? 240 : null))
    expect(hasChanged(before, after)).toBe(true)
  })

  it('変わった画素が少なすぎる場合は変化とみなさない', () => {
    const before = bitmap(1000, 120)
    const after = bitmap(1000, 120, (i) => (i < 5 ? 240 : null)) // 0.5%
    expect(hasChanged(before, after)).toBe(false)
  })

  it('しきい値は呼び出し側で変えられる', () => {
    const before = bitmap(1000, 120)
    const after = bitmap(1000, 120, (i) => (i < 5 ? 240 : null))
    expect(hasChanged(before, after, { sameRatio: 0.001 })).toBe(true)
  })

  it('大きさが違う画像は変化とみなす（ウィンドウのリサイズ）', () => {
    expect(hasChanged(bitmap(100), bitmap(200))).toBe(true)
  })

  it('既定のしきい値は控えめにしてある', () => {
    expect(DEFAULT_SAME_RATIO).toBeLessThan(0.05)
  })
})

describe('ファイル名と保存サイズ', () => {
  it('時刻順に並ぶよう0埋めする', () => {
    expect(frameFileName(1, 'jpeg')).toBe('00001.jpeg')
    expect(frameFileName(1234, 'png')).toBe('01234.png')
  })

  it('上限より小さい画像は縮小しない', () => {
    expect(targetWidth(1200, 1600)).toBeNull()
    expect(targetWidth(1600, 1600)).toBeNull()
  })

  it('上限より大きい画像は上限まで縮める（Retinaの原寸対策）', () => {
    expect(targetWidth(3024, 1600)).toBe(1600)
  })

  it('上限0なら原寸のまま', () => {
    expect(targetWidth(3024, 0)).toBeNull()
  })
})
