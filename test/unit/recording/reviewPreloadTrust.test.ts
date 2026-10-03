import { beforeAll, describe, expect, it, vi } from 'vitest'

/*
 * security-2 [10] の再現の筋を、注入スクリプト（src/preload/review.ts）そのもので確かめる。
 * ページのスクリプトが dispatchEvent で起こした入力は isTrusted が false になる。Node の EventTarget で
 * 起こしたイベントも同じく isTrusted が false なので、ページの合成の入力の代わりに使える。
 * DOM は、注入スクリプトが使う分だけの最小の偽物を置く（jsdom は使っていない）。
 */

const sent: Array<{ channel: string; payload: unknown }> = []
const commandHandlers: Array<(event: unknown, command: unknown) => void> = []

vi.mock('electron', () => ({
  ipcRenderer: {
    send: (channel: string, payload?: unknown) => { sent.push({ channel, payload }) },
    on: (_channel: string, handler: (event: unknown, command: unknown) => void) => { commandHandlers.push(handler) }
  },
  contextBridge: { executeInMainWorld: () => undefined }
}))

/** 描画の呼び出しは何もしない 2D コンテキスト */
const noopContext = new Proxy({}, { get: () => () => undefined, set: () => true })

class FakeElement extends EventTarget {
  style: Record<string, string> = {}
  children: FakeElement[] = []
  isConnected = true
  width = 0
  height = 0
  localName: string
  constructor(tag: string) {
    super()
    this.localName = tag
  }
  setAttribute(): void {}
  getAttribute(): null { return null }
  append(child: FakeElement): void { this.children.push(child) }
  contains(): boolean { return false }
  showPopover(): void {}
  getContext(): unknown { return noopContext }
  setPointerCapture(): void {}
  hasPointerCapture(): boolean { return false }
  releasePointerCapture(): void {}
  closest(): null { return null }
  matches(): boolean { return false }
}

let layer: FakeElement | undefined

function command(value: unknown): void {
  for (const handler of commandHandlers) handler({}, value)
}

/** ページのスクリプトが起こす合成の入力（isTrusted は false） */
function synthetic(type: string, init: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: 120, clientY: 80, pointerId: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, ...init })
}

const recorded = (): unknown[] => sent.filter((s) => s.channel === 'ade-review:event').map((s) => s.payload)

beforeAll(async () => {
  const documentElement = new FakeElement('html')
  const doc = Object.assign(new EventTarget(), {
    readyState: 'complete',
    documentElement,
    createElement: (tag: string) => {
      const element = new FakeElement(tag)
      if (tag === 'div' && !layer) layer = element
      return element
    },
    elementFromPoint: () => null
  })
  const win = Object.assign(new EventTarget(), {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    scrollY: 0,
    location: { href: 'http://localhost:3000/' },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  })
  Object.assign(globalThis, { window: win, document: doc, Element: FakeElement, history: { pushState: () => undefined, replaceState: () => undefined } })
  await import('../../../src/preload/review')
  command({ type: 'enable' })
})

describe('security-2 [10] ページの合成の入力は記録も撮影も起こさない', () => {
  it('合成のクリックを何万回起こしても、操作ログを1件も送らない', () => {
    command({ type: 'mode', mode: 'off' })
    for (let i = 0; i < 20_000; i++) (document as unknown as EventTarget).dispatchEvent(synthetic('click', { clientX: i % 800 }))
    expect(recorded()).toEqual([])
  })

  it('描く層への合成の pointer では、書き込み（と、その静止画）を作らない', () => {
    command({ type: 'mode', mode: 'rect' })
    expect(layer).toBeDefined()
    for (let i = 0; i < 2_000; i++) {
      layer!.dispatchEvent(synthetic('pointerdown', { clientX: 10, clientY: 10 }))
      layer!.dispatchEvent(synthetic('pointermove', { clientX: 300, clientY: 200 }))
      layer!.dispatchEvent(synthetic('pointerup', { clientX: 300, clientY: 200 }))
    }
    command({ type: 'commit' })
    expect(recorded()).toEqual([])
    command({ type: 'mode', mode: 'off' })
  })

  it('合成のスクロール・カーソル移動・キー（道具の切り替え・元に戻す）も送らない', () => {
    for (let i = 0; i < 2_000; i++) {
      ;(window as unknown as EventTarget).dispatchEvent(synthetic('scroll'))
      ;(document as unknown as EventTarget).dispatchEvent(synthetic('pointermove'))
      ;(window as unknown as EventTarget).dispatchEvent(synthetic('keydown', { key: 'p' }))
      ;(window as unknown as EventTarget).dispatchEvent(synthetic('keydown', { key: 'z', metaKey: true, ctrlKey: true }))
    }
    expect(sent.filter((s) => s.channel !== 'ade-review:ready')).toEqual([])
  })

  it('（確かめ方の確認）main からの指示への返事は送れる。上の「送らない」が配線の不具合で通ったのではない', () => {
    command({ type: 'leave' })
    expect(recorded()).toEqual([expect.objectContaining({ type: 'left' })])
  })
})
