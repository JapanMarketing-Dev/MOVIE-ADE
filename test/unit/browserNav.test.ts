import { describe, expect, it } from 'vitest'
import type { CaptureTarget } from '../../src/shared/types'
import { browserNavAccelerator, browserNavKeys, canBrowserNav, showsBrowserNav } from '../../src/shared/browserNav'

const browser = { kind: 'browser' } as const
const history = { canGoBack: true, canGoForward: false }

describe('フィードバックモードの戻る・進む', () => {
  it('履歴が無い向きは押せない', () => {
    expect(canBrowserNav('back', history, browser)).toBe(true)
    expect(canBrowserNav('forward', history, browser)).toBe(false)
    expect(canBrowserNav('back', { canGoBack: false, canGoForward: false }, browser)).toBe(false)
  })

  it('画面全体・ウインドウを録るときは出さず、押せない（内蔵ブラウザを操作しない）', () => {
    const screen: CaptureTarget = { kind: 'screen', sourceId: 'screen:1:0', name: '画面 1' }
    const window: CaptureTarget = { kind: 'window', sourceId: 'window:42:0', name: 'Simulator' }
    expect(showsBrowserNav(browser)).toBe(true)
    expect(showsBrowserNav(screen)).toBe(false)
    expect(showsBrowserNav(window)).toBe(false)
    expect(canBrowserNav('back', { canGoBack: true, canGoForward: true }, screen)).toBe(false)
    expect(canBrowserNav('forward', { canGoBack: true, canGoForward: true }, window)).toBe(false)
  })

  it('ショートカットは macOS で ⌘[ / ⌘]、それ以外で Alt+← / Alt+→。画面の表記と対応する', () => {
    expect(browserNavAccelerator('back', 'darwin')).toBe('Cmd+[')
    expect(browserNavAccelerator('forward', 'darwin')).toBe('Cmd+]')
    expect(browserNavAccelerator('back', 'win32')).toBe('Alt+Left')
    expect(browserNavAccelerator('forward', 'linux')).toBe('Alt+Right')
    expect(browserNavKeys('back', 'darwin')).toEqual(['Mod', '['])
    expect(browserNavKeys('forward', 'win32')).toEqual(['Alt', 'ArrowRight'])
  })
})
