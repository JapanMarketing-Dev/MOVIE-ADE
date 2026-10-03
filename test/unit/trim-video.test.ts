import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 削った版を作る非表示ウィンドウ（trimVideo.ts）。ページの処理は Electron の中でしか動かないので、
 * executeJavaScript の結果だけを差し替えて、やり直しと失敗の扱いを確かめる
 */
const page = vi.hoisted(() => ({ runs: [] as Array<() => Promise<unknown>>, windows: 0, destroyed: 0 }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    private gone = false
    webContents = {
      setAudioMuted: () => {},
      executeJavaScript: (code: string) => {
        if (code.startsWith('window.__trimPull')) return Promise.resolve(Buffer.from('webm').toString('base64'))
        const run = page.runs.shift()
        return run ? run() : Promise.resolve(4)
      }
    }
    constructor() { page.windows++ }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return this.gone }
    destroy() { this.gone = true; page.destroyed++ }
  }
}))

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ferret-trimvideo-'))
  page.runs = []
  page.windows = 0
  page.destroyed = 0
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('削った版を作る（renderTrimmedVideo）', () => {
  it('1回目がページの中で失敗しても、新しいウィンドウでやり直して書き出す', async () => {
    // e2e で見つかった形: Error でない値（中身の無い DOMException）で reject される
    page.runs = [() => Promise.reject({}), () => Promise.resolve(4)]
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    const out = join(dir, 'out.webm')
    await renderTrimmedVideo('ade-media://review/x/recording.webm', out, [{ start: 0, end: 1000 }])
    expect(await readFile(out, 'utf8')).toBe('webm')
    expect(page.windows).toBe(2)
    expect(page.destroyed).toBe(2)
  })

  it('やり直しても失敗したら、理由の読める Error で投げ、途中のファイルを残さない', async () => {
    page.runs = [() => Promise.reject({ name: 'AbortError', message: 'The play() request was interrupted' }), () => Promise.reject({})]
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    const out = join(dir, 'out.webm')
    const err = await renderTrimmedVideo('ade-media://review/x/recording.webm', out, [{ start: 0, end: 1000 }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^trim failed: /)
    expect(existsSync(out)).toBe(false)
    expect(page.destroyed).toBe(2)
  })

  it('中身の無い結果は失敗として扱う', async () => {
    page.runs = [() => Promise.resolve(0)]
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    await expect(renderTrimmedVideo('ade-media://review/x/recording.webm', join(dir, 'out.webm'), [{ start: 0, end: 1000 }], { attempts: 1 }))
      .rejects.toThrow('trim produced no data')
  })
})
