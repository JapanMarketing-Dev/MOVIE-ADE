import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectWatcher } from '../../src/main/files'

/** 監視がエラーで止まっても、フォルダがあれば張り直す（Orca #17878 #24044） */
type Inner = { watcher: { emit: (event: string, err: Error) => void } | null }

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ade-watch-'))
  dirs.push(dir)
  return dir
}

describe('ProjectWatcher の張り直し', () => {
  it('エラーで止まったら、少し待って同じフォルダを見張り直す', () => {
    vi.useFakeTimers()
    const root = project()
    const watcher = new ProjectWatcher(() => {})
    watcher.watch(root)
    const inner = watcher as unknown as Inner
    inner.watcher!.emit('error', new Error('EMFILE'))
    expect(inner.watcher).toBeNull()
    vi.advanceTimersByTime(2000)
    expect(inner.watcher).not.toBeNull()
    watcher.close()
  })

  it('フォルダが消えていたら張り直さない。close したら予約も消す', () => {
    vi.useFakeTimers()
    const root = project()
    const watcher = new ProjectWatcher(() => {})
    watcher.watch(root)
    const inner = watcher as unknown as Inner
    inner.watcher!.emit('error', new Error('gone'))
    rmSync(root, { recursive: true, force: true })
    vi.advanceTimersByTime(2000)
    expect(inner.watcher).toBeNull()

    const other = project()
    watcher.watch(other)
    inner.watcher!.emit('error', new Error('EMFILE'))
    watcher.close()
    vi.advanceTimersByTime(60_000)
    expect(inner.watcher).toBeNull()
  })

  it('何度も止まるときは回数に上限がある', () => {
    vi.useFakeTimers()
    const root = project()
    const watcher = new ProjectWatcher(() => {})
    watcher.watch(root)
    const inner = watcher as unknown as Inner
    let rewatched = 0
    for (let i = 0; i < 10; i++) {
      if (!inner.watcher) break
      inner.watcher.emit('error', new Error('EMFILE'))
      vi.advanceTimersByTime(2000 * 2 ** i)
      if (inner.watcher) rewatched++
    }
    expect(rewatched).toBe(5)
    watcher.close()
  })
})
