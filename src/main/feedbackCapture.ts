import { MAX_IMAGE_BYTES } from '@shared/feedbackRelay'

/**
 * フィードバックに添える Ferret の画面の静止画を、中継の上限（1枚 2MB）に収める。
 * まず PNG のまま、大きければ幅を縮め、それでも大きければ JPEG にする。
 * Electron の NativeImage の形だけに依存する（単体テストでは偽の画像を渡す）。
 */

export interface ImageLike {
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
  getSize(): { width: number; height: number }
  resize(options: { width: number; quality?: 'good' | 'better' | 'best' }): ImageLike
}

export interface FittedImage {
  type: 'image/png' | 'image/jpeg'
  base64: string
  width: number
  height: number
}

/** これより細くはしない（文字が読めなくなる） */
const MIN_WIDTH = 640

export function fitScreenshot(image: ImageLike, maxBytes = MAX_IMAGE_BYTES): FittedImage {
  let current = image
  for (;;) {
    const png = current.toPNG()
    const size = current.getSize()
    if (png.length <= maxBytes) return { type: 'image/png', base64: png.toString('base64'), ...size }
    if (size.width / 1.5 < MIN_WIDTH) break
    current = current.resize({ width: Math.round(size.width / 1.5), quality: 'good' })
  }
  for (const quality of [85, 70, 55]) {
    const jpeg = current.toJPEG(quality)
    if (jpeg.length <= maxBytes) return { type: 'image/jpeg', base64: jpeg.toString('base64'), ...current.getSize() }
  }
  throw new Error('screenshot does not fit the size limit')
}
