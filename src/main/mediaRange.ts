/**
 * 録画の動画（ade-media://）を Range 付きで返す。
 * file:// の net.fetch は Range を扱わず全体を 200 で返すため、video が seek できず ▷ が 0 秒から始まってしまう。
 * Range を見て 206 と Content-Range を返し、指摘の時刻へ飛べるようにする。
 */
import type { FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'

/** `bytes=start-end` を読む。読めない・範囲外は null（全体を返す）、満たせない範囲は 'unsatisfiable' */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // 複数範囲などは扱わない（全体を返す。video は単一範囲しか送らない）
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (size <= 0) return 'unsatisfiable'
  if (m[1] === '') {
    // 末尾から n バイト
    const suffix = Number(m[2])
    if (suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * 確かめて開いた FileHandle から返す（パスを開き直さない。security-4 [5]）。動画を返す口はこれだけにする
 * （パスから開き直す口を置くと、確かめたあとで差し替えられた外のファイルを返しうる。security-7 [13]）。
 * handle は返した Response の本文を読み終えるか中断したときに閉じる（本文が無ければすぐ閉じる）
 */
export async function mediaResponseFromHandle(handle: FileHandle, rangeHeader: string | null, contentType: string): Promise<Response> {
  const { size } = await handle.stat()
  const range = parseByteRange(rangeHeader, size)
  if (range === 'unsatisfiable' || size <= 0) {
    await handle.close()
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } })
    return new Response(null, { status: 200, headers: { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Length': '0' } })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const body = Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as ReadableStream<Uint8Array>
  const headers: Record<string, string> = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status: range ? 206 : 200, headers })
}
