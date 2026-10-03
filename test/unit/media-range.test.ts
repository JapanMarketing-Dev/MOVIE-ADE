import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mediaResponse, parseByteRange } from '../../src/main/mediaRange'

describe('録画の動画を Range 付きで返す（▷ を指摘の時刻から開くため）', () => {
  it('bytes=start-end・start-・末尾 n バイトを読む', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 })
  })

  it('無い・読めない Range は全体、満たせない Range は 416', () => {
    expect(parseByteRange(null, 100)).toBeNull()
    expect(parseByteRange('items=0-1', 100)).toBeNull()
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=20-10', 100)).toBe('unsatisfiable')
  })

  it('Range があれば 206 と Content-Range で一部だけ返す', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferret-media-'))
    try {
      const file = join(dir, 'recording.webm')
      await writeFile(file, Buffer.from('0123456789'))
      const part = await mediaResponse(file, 'bytes=2-5')
      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
      expect(part.headers.get('accept-ranges')).toBe('bytes')
      expect(await part.text()).toBe('2345')
      const whole = await mediaResponse(file, null)
      expect(whole.status).toBe(200)
      expect(whole.headers.get('accept-ranges')).toBe('bytes')
      expect(await whole.text()).toBe('0123456789')
      expect((await mediaResponse(file, 'bytes=50-')).status).toBe(416)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
