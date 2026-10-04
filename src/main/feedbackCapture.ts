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

interface FittedImage {
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

// ─── 内蔵ブラウザを重ねる（第2段: Ferret 自身の画面を、動画なし・ペンなしの静止画で報告する） ───
//
// mainWindow.webContents.capturePage() には、別のレイヤーにある内蔵ブラウザ（WebContentsView）が写らない
// （そこだけ空く）。画面収録の許可を求めずに済むよう、ビューも自分の capturePage() で撮り、
// ウインドウの画像の同じ位置に重ねる。重ねるのは生のピクセル（toBitmap の BGRA）で、ここは純粋な計算だけ。

interface Bitmap {
  /** 1画素 4 バイト（toBitmap の並びのまま。重ねるだけなので色の順は問わない） */
  data: Uint8Array
  width: number
  height: number
}

/**
 * NativeImage の getSize() は DIP のことがある（Retina で 2 倍の画素を持つ）。toBitmap の長さから本当の画素数を求める。
 * 合わなければ null
 */
export function pixelSize(size: { width: number; height: number }, byteLength: number): { width: number; height: number } | null {
  if (size.width <= 0 || size.height <= 0) return null
  const scale = Math.sqrt(byteLength / 4 / (size.width * size.height))
  const width = Math.round(size.width * scale)
  const height = Math.round(size.height * scale)
  return width * height * 4 === byteLength ? { width, height } : null
}

/**
 * ビューの位置（ウインドウの中身の DIP）を、ウインドウの画像の画素の矩形へ移す。
 * 縦横それぞれの比で掛け、画像の外へはみ出す分は切る。空なら null
 */
export function placeView(
  view: { x: number; y: number; width: number; height: number },
  windowSize: { width: number; height: number },
  image: { width: number; height: number }
): { x: number; y: number; width: number; height: number } | null {
  if (windowSize.width <= 0 || windowSize.height <= 0) return null
  const sx = image.width / windowSize.width
  const sy = image.height / windowSize.height
  const x = Math.round(view.x * sx)
  const y = Math.round(view.y * sy)
  const width = Math.min(Math.round(view.width * sx), image.width - x)
  const height = Math.min(Math.round(view.height * sy), image.height - y)
  return x >= 0 && y >= 0 && width > 0 && height > 0 ? { x, y, width, height } : null
}

/** base の (x, y) に overlay を上書きで重ねた新しい画素列（はみ出しは切る。base は変えない） */
export function compositeBitmap(base: Bitmap, overlay: Bitmap, at: { x: number; y: number }): Uint8Array {
  const out = new Uint8Array(base.data)
  const x0 = Math.max(0, at.x)
  const y0 = Math.max(0, at.y)
  const x1 = Math.min(base.width, at.x + overlay.width)
  const y1 = Math.min(base.height, at.y + overlay.height)
  if (x1 <= x0 || y1 <= y0) return out
  for (let y = y0; y < y1; y++) {
    const from = ((y - at.y) * overlay.width + (x0 - at.x)) * 4
    out.set(overlay.data.subarray(from, from + (x1 - x0) * 4), (y * base.width + x0) * 4)
  }
  return out
}

export interface CapturableImage {
  getSize(): { width: number; height: number }
  toBitmap(): Buffer
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): CapturableImage
}

/**
 * ウインドウの静止画に、内蔵ブラウザのビューの静止画を重ねた画素列。ビューが無い・撮れなかった・形が合わないときは null
 * （呼び出し側はウインドウの画像だけを使う）
 */
export function overlayView(
  windowImage: CapturableImage,
  windowContentSize: { width: number; height: number },
  view: { image: CapturableImage; bounds: { x: number; y: number; width: number; height: number } } | null
): Bitmap | null {
  if (!view) return null
  const baseData = windowImage.toBitmap()
  const baseSize = pixelSize(windowImage.getSize(), baseData.length)
  if (!baseSize) return null
  const target = placeView(view.bounds, windowContentSize, baseSize)
  if (!target) return null
  const resized = view.image.resize({ width: target.width, height: target.height, quality: 'good' })
  const overlayData = resized.toBitmap()
  const overlaySize = pixelSize(resized.getSize(), overlayData.length)
  if (!overlaySize) return null
  const data = compositeBitmap({ data: baseData, ...baseSize }, { data: overlayData, ...overlaySize }, target)
  return { data, ...baseSize }
}
