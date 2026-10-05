/**
 * 内蔵ブラウザのタブの決まり（src/shared/browserTabs.ts）。
 * 開く・閉じる・切り替える・キー・帯に出す名前を、Electron 抜きで確かめる
 */
import { describe, expect, it } from 'vitest'
import { MAX_BROWSER_TABS, browserTabKeyAction, canOpenTab, cycleTab, nextTabId, tabAfterClose, tabAtNumber, tabLabel, type TabKeyInput } from '../../src/shared/browserTabs'

const key = (k: string, mods: Partial<TabKeyInput> = {}): TabKeyInput => ({ key: k, control: false, meta: false, alt: false, shift: false, ...mods })

describe('タブを開く', () => {
  it('上限までは開ける', () => {
    expect(MAX_BROWSER_TABS).toBe(20)
    expect(canOpenTab(0)).toBe(true)
    expect(canOpenTab(MAX_BROWSER_TABS - 1)).toBe(true)
    expect(canOpenTab(MAX_BROWSER_TABS)).toBe(false)
  })

  it('id は番号で、閉じた番号を使い直さない', () => {
    expect(nextTabId(1)).toBe('tab-1')
    expect(nextTabId(12)).toBe('tab-12')
  })
})

describe('タブを閉じたあとに前に出すタブ', () => {
  const ids = ['a', 'b', 'c']
  it('前に出ていないタブを閉じても、いまのまま', () => {
    expect(tabAfterClose(ids, 'a', 'b')).toBe('b')
    expect(tabAfterClose(ids, 'c', 'b')).toBe('b')
  })

  it('前のタブを閉じたら右隣、右端なら左隣', () => {
    expect(tabAfterClose(ids, 'a', 'a')).toBe('b')
    expect(tabAfterClose(ids, 'b', 'b')).toBe('c')
    expect(tabAfterClose(ids, 'c', 'c')).toBe('b')
  })

  it('最後の1枚なら null（呼び出し側が空のタブを開く）。知らない id は先頭か、いまのまま', () => {
    expect(tabAfterClose(['a'], 'a', 'a')).toBeNull()
    expect(tabAfterClose(ids, 'x', 'b')).toBe('b')
    expect(tabAfterClose(ids, 'x', 'x')).toBe('a')
  })
})

describe('番号・順に切り替える', () => {
  const ids = ['a', 'b', 'c']
  it('⌘1〜8 はその番号、⌘9 は最後。無い番号は null', () => {
    expect(tabAtNumber(ids, 1)).toBe('a')
    expect(tabAtNumber(ids, 3)).toBe('c')
    expect(tabAtNumber(ids, 4)).toBeNull()
    expect(tabAtNumber(ids, 9)).toBe('c')
    expect(tabAtNumber(ids, 0)).toBeNull()
    expect(tabAtNumber([], 1)).toBeNull()
  })

  it('次・前は端で反対の端へ回る', () => {
    expect(cycleTab(ids, 'a', 1)).toBe('b')
    expect(cycleTab(ids, 'c', 1)).toBe('a')
    expect(cycleTab(ids, 'a', -1)).toBe('c')
    expect(cycleTab(ids, 'zz', 1)).toBe('a')
    expect(cycleTab([], 'a', 1)).toBeNull()
  })
})

describe('タブのキー', () => {
  it('macOS は ⌘T / ⌘W / ⌘1〜9、Ctrl+Tab / Ctrl+Shift+Tab', () => {
    expect(browserTabKeyAction(key('t', { meta: true }), 'darwin')).toEqual({ type: 'new' })
    expect(browserTabKeyAction(key('T', { meta: true }), 'darwin')).toEqual({ type: 'new' })
    expect(browserTabKeyAction(key('w', { meta: true }), 'darwin')).toEqual({ type: 'close' })
    expect(browserTabKeyAction(key('3', { meta: true }), 'darwin')).toEqual({ type: 'number', n: 3 })
    expect(browserTabKeyAction(key('Tab', { control: true }), 'darwin')).toEqual({ type: 'cycle', step: 1 })
    expect(browserTabKeyAction(key('Tab', { control: true, shift: true }), 'darwin')).toEqual({ type: 'cycle', step: -1 })
    // macOS の Ctrl+T（ターミナルの文字の入れ替え）・Ctrl+1 は取らない
    expect(browserTabKeyAction(key('t', { control: true }), 'darwin')).toBeNull()
    expect(browserTabKeyAction(key('1', { control: true }), 'darwin')).toBeNull()
  })

  it('Windows / Linux は Ctrl', () => {
    for (const platform of ['win32', 'linux']) {
      expect(browserTabKeyAction(key('t', { control: true }), platform)).toEqual({ type: 'new' })
      expect(browserTabKeyAction(key('w', { control: true }), platform)).toEqual({ type: 'close' })
      expect(browserTabKeyAction(key('9', { control: true }), platform)).toEqual({ type: 'number', n: 9 })
      expect(browserTabKeyAction(key('Tab', { control: true }), platform)).toEqual({ type: 'cycle', step: 1 })
      expect(browserTabKeyAction(key('t', { meta: true }), platform)).toBeNull()
    }
  })

  it('ほかのショートカット（⌘⇧W 窓を閉じる・⌘⇧T・Alt・⌘0・修飾キーの無い文字）とは重ならない', () => {
    expect(browserTabKeyAction(key('w', { meta: true, shift: true }), 'darwin')).toBeNull()
    expect(browserTabKeyAction(key('t', { meta: true, shift: true }), 'darwin')).toBeNull()
    expect(browserTabKeyAction(key('t', { meta: true, alt: true }), 'darwin')).toBeNull()
    expect(browserTabKeyAction(key('0', { meta: true }), 'darwin')).toBeNull()
    expect(browserTabKeyAction(key('r', { meta: true }), 'darwin')).toBeNull()
    for (const k of ['p', 'b', 'v', 'c', 't', 'w', '1', 'Tab']) expect(browserTabKeyAction(key(k), 'darwin'), k).toBeNull()
    expect(browserTabKeyAction(key('Tab', { meta: true }), 'darwin')).toBeNull()
  })
})

describe('タブの帯に出す名前', () => {
  it('題名、無ければホストとパス、空のタブは空', () => {
    expect(tabLabel({ title: '受信トレイ', url: 'https://mail.example.com/inbox' })).toBe('受信トレイ')
    expect(tabLabel({ title: '', url: 'https://mail.example.com/inbox' })).toBe('mail.example.com/inbox')
    expect(tabLabel({ title: 'http://127.0.0.1:4321/', url: 'http://127.0.0.1:4321/' })).toBe('127.0.0.1:4321')
    expect(tabLabel({ title: '', url: 'about:blank' })).toBe('')
    expect(tabLabel({ title: 'about:blank', url: 'about:blank' })).toBe('')
    expect(tabLabel({ title: '', url: '' })).toBe('')
    expect(tabLabel({ title: '', url: 'ade-preview://p/a.md' })).toBe('ade-preview://p/a.md')
  })
})
