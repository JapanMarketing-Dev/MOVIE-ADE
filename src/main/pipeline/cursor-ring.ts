/** Electron NativeImageのBGRA画素へ、指した位置を示すリングを重ねる。 */
export function cursorRing(bitmap: Buffer, width: number, height: number, x: number, y: number): Buffer {
  const result = Buffer.from(bitmap)
  const radius = Math.max(12, Math.round(width / 70))
  for (let py = Math.max(0, Math.floor(y - radius - 4)); py < Math.min(height, Math.ceil(y + radius + 4)); py++) {
    for (let px = Math.max(0, Math.floor(x - radius - 4)); px < Math.min(width, Math.ceil(x + radius + 4)); px++) {
      const distance = Math.abs(Math.hypot(px - x, py - y) - radius)
      if (distance > 3.5) continue
      const i = (py * width + px) * 4
      const red = distance < 2
      result[i] = red ? 48 : 255
      result[i + 1] = red ? 59 : 255
      result[i + 2] = 255
      result[i + 3] = 255
    }
  }
  return result
}
