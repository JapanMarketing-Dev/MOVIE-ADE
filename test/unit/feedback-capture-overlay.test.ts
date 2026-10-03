import { describe, expect, it } from 'vitest'
import { compositeBitmap, overlayView, pixelSize, placeView, type CapturableImage } from '../../src/main/feedbackCapture'

/** 1色で塗った偽の画像（画素は 4 バイト。scale で getSize() を DIP に見せる） */
function solid(width: number, height: number, value: number, scale = 1): CapturableImage {
  const data = Buffer.alloc(width * height * 4, value)
  return {
    getSize: () => ({ width: width / scale, height: height / scale }),
    toBitmap: () => data,
    resize: ({ width: w, height: h }) => solid(w, h, value)
  }
}

describe('Ferret の画面の静止画に内蔵ブラウザを重ねる（第2段・動画なし）', () => {
  it('getSize() が DIP でも、toBitmap の長さから本当の画素数を求める', () => {
    expect(pixelSize({ width: 100, height: 50 }, 200 * 100 * 4)).toEqual({ width: 200, height: 100 })
    expect(pixelSize({ width: 100, height: 50 }, 100 * 50 * 4)).toEqual({ width: 100, height: 50 })
    expect(pixelSize({ width: 100, height: 50 }, 123)).toBeNull()
    expect(pixelSize({ width: 0, height: 50 }, 0)).toBeNull()
  })

  it('ビューの位置（DIP）を画像の画素へ移し、はみ出しは切る', () => {
    expect(placeView({ x: 10, y: 20, width: 30, height: 40 }, { width: 100, height: 100 }, { width: 200, height: 200 })).toEqual({ x: 20, y: 40, width: 60, height: 80 })
    expect(placeView({ x: 90, y: 0, width: 30, height: 10 }, { width: 100, height: 100 }, { width: 100, height: 100 })).toEqual({ x: 90, y: 0, width: 10, height: 10 })
    expect(placeView({ x: 0, y: 0, width: 0, height: 10 }, { width: 100, height: 100 }, { width: 100, height: 100 })).toBeNull()
    expect(placeView({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, { width: 100, height: 100 })).toBeNull()
  })

  it('重ねるのは指定の矩形だけ。元の画素列は変えない', () => {
    const base = { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4 }
    const overlay = { data: new Uint8Array(2 * 2 * 4).fill(9), width: 2, height: 2 }
    const out = compositeBitmap(base, overlay, { x: 1, y: 1 })
    const at = (x: number, y: number) => out[(y * 4 + x) * 4]
    expect([at(0, 0), at(1, 1), at(2, 2), at(3, 3), at(3, 1)]).toEqual([0, 9, 9, 0, 0])
    expect(base.data.every((v) => v === 0)).toBe(true)
    // 画像の外へはみ出す分は切る
    const edge = compositeBitmap(base, overlay, { x: 3, y: -1 })
    expect(edge[(0 * 4 + 3) * 4]).toBe(9)
    expect(edge.filter((v) => v === 9).length).toBe(4)
  })

  it('Retina のウインドウ画像にも、ビューを同じ位置へ重ねる。ビューが無ければ null', () => {
    const merged = overlayView(solid(200, 100, 1, 2), { width: 100, height: 50 }, { image: solid(50, 25, 7), bounds: { x: 50, y: 0, width: 50, height: 25 } })
    expect(merged).toMatchObject({ width: 200, height: 100 })
    const px = (x: number, y: number) => merged!.data[(y * 200 + x) * 4]
    expect([px(0, 0), px(100, 0), px(199, 49), px(99, 0), px(100, 50)]).toEqual([1, 7, 7, 1, 1])
    expect(overlayView(solid(10, 10, 1), { width: 10, height: 10 }, null)).toBeNull()
  })
})
