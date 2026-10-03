import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountHero } from '../../site/js/hero.js'

/**
 * LP のヒーロー（site/js/hero.js）の表示切り替え:
 * 最初の1コマを描くまでは onFirstFrame を呼ばない（呼ばれるまでページは静止画を出したまま）。
 * 画面外・タブが隠れているあいだは描かず、止めても最後のコマを残し、サイズが変わったら描き直す。
 */

/** 何を呼んでも何もしない 2D コンテキスト（描いた回数だけ数える） */
function fakeContext() {
  let draws = 0
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key === 'draws') return draws
      if (key === 'clearRect') return () => draws++
      if (key === 'measureText') return () => ({ width: 10 })
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (key in target) return target[key as string]
      return () => {}
    },
    set(target, key, value) {
      target[key as string] = value
      return true
    },
  })
  return ctx as unknown as { draws: number }
}

function setup() {
  const frames: Array<(t: number) => void> = []
  let io: (entries: Array<{ isIntersecting: boolean }>) => void = () => {}
  let ro: () => void = () => {}
  const listeners: Record<string, () => void> = {}
  const doc = { hidden: false, addEventListener: (type: string, fn: () => void) => (listeners[type] = fn) }
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) => frames.push(fn))
  vi.stubGlobal('cancelAnimationFrame', () => frames.splice(0))
  vi.stubGlobal('IntersectionObserver', class { constructor(fn: typeof io) { io = fn } observe() {} })
  vi.stubGlobal('ResizeObserver', class { constructor(fn: typeof ro) { ro = fn } observe() {} })
  vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} })
  const ctx = fakeContext()
  const canvas = { clientWidth: 500, width: 0, height: 0, getContext: () => ctx, dispatchEvent: () => true }
  const step = (t: number) => frames.splice(0).forEach((fn) => fn(t))
  return { canvas, ctx, doc, listeners, step, show: (on: boolean) => io([{ isIntersecting: on }]), resize: () => ro() }
}

afterEach(() => vi.unstubAllGlobals())

describe('mountHero', () => {
  it('最初のコマを描いてから onFirstFrame を1回だけ呼ぶ', () => {
    const h = setup()
    const onFirstFrame = vi.fn()
    expect(mountHero(h.canvas as never, { onFirstFrame })).toBe(true)
    expect(onFirstFrame).not.toHaveBeenCalled()
    h.show(true)
    expect(onFirstFrame).not.toHaveBeenCalled() // 予約しただけでは描いていない
    h.step(16)
    expect(onFirstFrame).toHaveBeenCalledTimes(1)
    expect(h.ctx.draws).toBe(1)
    h.step(32)
    expect(onFirstFrame).toHaveBeenCalledTimes(1)
  })

  it('画面外やタブが隠れているあいだは描かない', () => {
    const h = setup()
    const onFirstFrame = vi.fn()
    h.doc.hidden = true
    mountHero(h.canvas as never, { onFirstFrame })
    h.show(true)
    h.step(16)
    expect(onFirstFrame).not.toHaveBeenCalled()
    h.doc.hidden = false
    h.show(false)
    h.listeners.visibilitychange()
    h.step(16)
    expect(onFirstFrame).not.toHaveBeenCalled()
    h.show(true)
    h.step(16)
    expect(onFirstFrame).toHaveBeenCalledTimes(1)
  })

  it('止めたあとにサイズが変わったら、最後のコマを描き直す', () => {
    const h = setup()
    mountHero(h.canvas as never)
    h.resize()
    expect(h.ctx.draws).toBe(0) // まだ1コマも無いので描かない（静止画のまま）
    h.show(true)
    h.step(16)
    h.show(false)
    const before = h.ctx.draws
    h.resize()
    expect(h.ctx.draws).toBe(before + 1)
  })
})
