import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPackagedBuild } from '../../src/main/runtimeKind'

/**
 * 配布版・開発版の判定（src/main/runtime.ts / runtimeKind.ts）。
 * 名前を変えた開発版の Electron（MOVIE-ADE Dev.app）でも app.isPackaged は true になるので、main では IS_PACKAGED だけを使う。
 */

const MAIN = resolve(__dirname, '../../src/main')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mts)$/.test(name) ? [path] : []
  })
}

describe('IS_PACKAGED', () => {
  it('src/main で app.isPackaged を直接使うのは runtime.ts だけ', () => {
    const offenders = files(MAIN)
      .filter((path) => relative(MAIN, path) !== 'runtime.ts')
      .filter((path) => /\bapp\??\.isPackaged\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(MAIN, path))
    expect(offenders).toEqual([])
  })

  it('配布版: app.isPackaged が true で、defaultApp も ELECTRON_RENDERER_URL も無い', () => {
    expect(isPackagedBuild({ isPackaged: true, defaultApp: undefined, rendererUrl: undefined })).toBe(true)
  })

  it('pnpm dev（名前を変えた MOVIE-ADE Dev.app）: app.isPackaged が true でも開発版', () => {
    expect(isPackagedBuild({ isPackaged: true, defaultApp: true, rendererUrl: 'http://localhost:5173' })).toBe(false)
    expect(isPackagedBuild({ isPackaged: true, defaultApp: true })).toBe(false)
    expect(isPackagedBuild({ isPackaged: false })).toBe(false)
  })

  describe('起動時の値', () => {
    const saved = { defaultApp: process.defaultApp, url: process.env.ELECTRON_RENDERER_URL }
    afterEach(() => {
      vi.resetModules()
      vi.doUnmock('electron')
      Object.defineProperty(process, 'defaultApp', { value: saved.defaultApp, configurable: true, writable: true })
      if (saved.url === undefined) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = saved.url
    })

    const load = async (opt: { isPackaged: boolean; defaultApp?: boolean; url?: string }) => {
      vi.resetModules()
      vi.doMock('electron', () => ({ app: { isPackaged: opt.isPackaged } }))
      Object.defineProperty(process, 'defaultApp', { value: opt.defaultApp, configurable: true, writable: true })
      if (opt.url === undefined) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = opt.url
      return (await import('../../src/main/runtime')).IS_PACKAGED
    }

    it('配布版の起動条件なら true', async () => {
      expect(await load({ isPackaged: true })).toBe(true)
    })

    it('pnpm dev の起動条件なら false', async () => {
      expect(await load({ isPackaged: true, defaultApp: true, url: 'http://localhost:5173' })).toBe(false)
    })
  })
})
