import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, fitZoom, stepZoom, wheelZoom } from '../../src/renderer/editor/imageZoom'

describe('画像のビューアの拡大率', () => {
  it('画面に合わせる: 大きい画像は縮め、小さい画像は引き伸ばさない', () => {
    expect(fitZoom({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5)
    expect(fitZoom({ width: 1000, height: 4000 }, { width: 1000, height: 1000 })).toBe(0.25)
    expect(fitZoom({ width: 10, height: 10 }, { width: 1000, height: 1000 })).toBe(1)
    expect(fitZoom({ width: 0, height: 0 }, { width: 1000, height: 1000 })).toBe(1)
    expect(fitZoom({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1)
  })

  it('一段ずつ拡大・縮小（段の間からは次の段へ、端で止まる）', () => {
    expect(stepZoom(1, 1)).toBe(1.5)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(0.6, 1)).toBe(0.75)
    expect(stepZoom(0.6, -1)).toBe(0.5)
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
  })

  it('ホイール: 上で拡大・下で縮小、範囲の外へは出ない', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1)
    expect(wheelZoom(1, 100)).toBeLessThan(1)
    expect(wheelZoom(MAX_ZOOM, -1000)).toBe(MAX_ZOOM)
    expect(wheelZoom(MIN_ZOOM, 1000)).toBe(MIN_ZOOM)
  })
})
