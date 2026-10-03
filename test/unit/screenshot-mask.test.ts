import { describe, expect, it } from 'vitest'
import { DEFAULT_MASK_SELECTORS, clampRect, displayToImage, rectFromDrag, scaleRects } from '@shared/screenshotMask'

describe('画面の添付: 塗りつぶしの範囲', () => {
  it('CSS の座標を、Retina の 2 倍の画像の座標へ移す', () => {
    expect(scaleRects([{ x: 10, y: 20, width: 100, height: 50 }], { width: 1440, height: 900 }, { width: 2880, height: 1800 }))
      .toEqual([{ x: 20, y: 40, width: 200, height: 100 }])
  })

  it('2MB に収めるために縮めた画像でも、縦横の比で移す。端数は外側へ丸めて隠し漏れを作らない', () => {
    const [r] = scaleRects([{ x: 10.2, y: 10.2, width: 33.3, height: 33.3 }], { width: 1440, height: 900 }, { width: 1920, height: 1200 })
    expect(r).toEqual({ x: 13, y: 13, width: 45, height: 45 })
    // 元の範囲（13.6〜58.0）を必ず含む
    expect(r!.x).toBeLessThanOrEqual(10.2 * 1920 / 1440)
    expect(r!.x + r!.width).toBeGreaterThanOrEqual((10.2 + 33.3) * 1920 / 1440)
  })

  it('画像の外へはみ出した分は切り、外にしか無いものは捨てる', () => {
    expect(scaleRects([
      { x: -50, y: 800, width: 300, height: 300 },
      { x: 2000, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 }
    ], { width: 1440, height: 900 }, { width: 1440, height: 900 })).toEqual([{ x: 0, y: 800, width: 250, height: 100 }])
    expect(clampRect({ x: 5, y: 5, width: -3, height: 4 }, { width: 10, height: 10 })).toBeNull()
    expect(scaleRects([{ x: 0, y: 0, width: 10, height: 10 }], { width: 0, height: 900 }, { width: 10, height: 10 })).toEqual([])
  })

  it('大きく見せた画像の上のドラッグを、画像の座標の矩形にする（どちら向きでも同じ）', () => {
    const display = { width: 720, height: 450 }
    const image = { width: 2880, height: 1800 }
    const a = displayToImage({ x: 100, y: 50 }, display, image)
    const b = displayToImage({ x: 10, y: 200 }, display, image)
    expect(rectFromDrag(a, b, image)).toEqual({ x: 40, y: 200, width: 360, height: 600 })
    expect(rectFromDrag(b, a, image)).toEqual({ x: 40, y: 200, width: 360, height: 600 })
  })

  it('小さすぎるドラッグ（誤クリック）は矩形にしない。画像の外まで引いても中で止まる', () => {
    expect(rectFromDrag({ x: 10, y: 10 }, { x: 12, y: 30 }, { width: 100, height: 100 })).toBeNull()
    expect(rectFromDrag({ x: 90, y: 90 }, { x: 300, y: 300 }, { width: 100, height: 100 })).toEqual({ x: 90, y: 90, width: 10, height: 10 })
  })

  it('既定で塗るのは、ターミナル・プロジェクト名・URL・ファイルの一覧・リポジトリ名', () => {
    expect(DEFAULT_MASK_SELECTORS).toEqual(expect.arrayContaining([
      '[data-testid="terminal-pane"]', '[data-testid="sidebar-project"]', '.titlebar__project-name',
      '[data-testid="url-input"]', '[data-testid="file-explorer"]', '[data-testid="statusbar-github"]'
    ]))
  })
})
