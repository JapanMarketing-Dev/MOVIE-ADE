/**
 * 送られた静止画を確かめて、公開してよい形にする。PNG と JPEG だけを受け付ける。
 * - 送ってきた Content-Type やファイル名は信用せず、中身の先頭のバイト（マジックバイト）と構造で判定する
 * - 位置情報などが入りうるメタデータ（JPEG の EXIF・XMP・コメント、PNG のテキストのチャンク・eXIf・tIME）を取り除く
 * - 構造が壊れていれば null（bad_image）
 */

export type SanitizedImage = { contentType: 'image/png' | 'image/jpeg'; ext: 'png' | 'jpg'; bytes: Uint8Array }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** 公開しない PNG のチャンク（テキスト・EXIF・更新日時） */
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

export function sanitizeImage(bytes: Uint8Array): SanitizedImage | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    const out = sanitizePng(bytes)
    return out && { contentType: 'image/png', ext: 'png', bytes: out }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const out = sanitizeJpeg(bytes)
    return out && { contentType: 'image/jpeg', ext: 'jpg', bytes: out }
  }
  return null
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function sanitizePng(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]
  let at = 8
  let first = true
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (!/^[A-Za-z]{4}$/.test(type)) return null
    const end = at + 12 + length
    if (end > bytes.length) return null
    // 最初のチャンクは IHDR（13 バイト）でなければならない
    if (first && (type !== 'IHDR' || length !== 13)) return null
    first = false
    if (!PNG_DROP.has(type)) parts.push(bytes.subarray(at, end))
    at = end
    // IEND のあとに付いたもの（別のファイルを隠すなど）は捨てる
    if (type === 'IEND') return concat(parts)
  }
  return null
}

function sanitizeJpeg(bytes: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // 埋め草の 0xFF
    if (marker === 0xff) {
      at += 1
      continue
    }
    // 長さを持たないマーカー（RST・TEM）
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(at, at + 2))
      at += 2
      continue
    }
    if (marker === 0xd9) return null // SOS の前に EOI
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    if (length < 2) return null
    const end = at + 2 + length
    if (end > bytes.length) return null
    if (marker === 0xda) {
      // SOS: ここから先は画像のデータ。最後の EOI までを写し、そのあとに付いたものは捨てる
      const eoi = lastEoi(bytes, end)
      if (eoi < 0) return null
      parts.push(bytes.subarray(at, eoi + 2))
      return concat(parts)
    }
    if (keepJpegSegment(marker, bytes.subarray(at + 4, end))) parts.push(bytes.subarray(at, end))
    at = end
  }
  return null
}

/** APP0（JFIF）・APP2 の ICC プロファイル・APP14（Adobe の色の変換）だけを残す。EXIF・XMP（APP1）やコメントは捨てる */
function keepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe) return false
  if (marker >= 0xe0 && marker <= 0xef) {
    if (marker === 0xe0 || marker === 0xee) return true
    if (marker === 0xe2) return String.fromCharCode(...payload.subarray(0, 12)) === 'ICC_PROFILE\u0000'
    return false
  }
  return true
}

function lastEoi(bytes: Uint8Array, from: number): number {
  for (let i = bytes.length - 2; i >= from; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i
  }
  return -1
}
