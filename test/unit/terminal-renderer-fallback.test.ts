import { describe, expect, it } from 'vitest'
import { isWebglUnavailable } from '../../src/renderer/terminal/rendererFallback'

describe('ターミナルの WebGL を使えない理由（FERRET-13）', () => {
  it('xterm が WebGL2 の文脈を取れなかったときは環境によるもの（送らない）', () => {
    expect(isWebglUnavailable(new Error('WebGL2 not supported null'))).toBe(true)
    expect(isWebglUnavailable('WebGL2 not supported [object WebGL2RenderingContext]')).toBe(true)
  })

  it('それ以外の失敗は不具合として送る', () => {
    expect(isWebglUnavailable(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isWebglUnavailable(new Error('failed: WebGL2 not supported'))).toBe(false)
    expect(isWebglUnavailable(null)).toBe(false)
  })
})
