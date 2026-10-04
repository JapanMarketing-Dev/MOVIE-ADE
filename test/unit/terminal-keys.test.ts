import { describe, expect, it } from 'vitest'
import { terminalKeyAction, type TerminalKeyEvent } from '../../src/renderer/terminal/terminalKeys'
import { DARK_BG_MIN_CONTRAST, LIGHT_BG_MIN_CONTRAST, minimumContrastFor, relativeLuminance } from '../../src/renderer/terminal/terminalContrast'

function key(k: string, mods: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }
}
const idle = { hasSelection: false, agentForeground: false }
const agent = { hasSelection: false, agentForeground: true }
const selected = { hasSelection: true, agentForeground: false }

describe('ターミナルで xterm より先に受けるキー（Orca #2412 #5611 #560 #5797 #21491）', () => {
  it('Agent が前面なら Shift+Enter は ESC+CR（改行）。どの OS でも同じ', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(terminalKeyAction(key('Enter', { shiftKey: true }), platform, agent)).toEqual({ kind: 'send', data: '\x1b\r' })
    }
  })

  it('シェルだけのときの Shift+Enter と、ほかの修飾キー付きの Enter は xterm に任せる', () => {
    expect(terminalKeyAction(key('Enter', { shiftKey: true }), 'win32', idle)).toBeNull()
    expect(terminalKeyAction(key('Enter'), 'darwin', agent)).toBeNull()
    expect(terminalKeyAction(key('Enter', { shiftKey: true, ctrlKey: true }), 'linux', agent)).toBeNull()
  })

  it('変換中（IME）のキーは横取りしない', () => {
    expect(terminalKeyAction(key('Enter', { shiftKey: true, isComposing: true }), 'darwin', agent)).toBeNull()
    expect(terminalKeyAction(key('Process', { keyCode: 229, ctrlKey: true }), 'win32', selected)).toBeNull()
  })

  it('Windows / Linux: 選択があるときの Ctrl+C はコピー、無ければ中断（^C）として xterm へ', () => {
    expect(terminalKeyAction(key('c', { ctrlKey: true }), 'win32', selected)).toEqual({ kind: 'copy' })
    expect(terminalKeyAction(key('c', { ctrlKey: true }), 'linux', idle)).toBeNull()
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), 'linux', idle)).toEqual({ kind: 'copy' })
  })

  it('Windows / Linux: Ctrl+V・Ctrl+Shift+V・Shift+Insert は貼り付け', () => {
    expect(terminalKeyAction(key('v', { ctrlKey: true }), 'win32', idle)).toEqual({ kind: 'paste' })
    expect(terminalKeyAction(key('V', { ctrlKey: true, shiftKey: true }), 'linux', idle)).toEqual({ kind: 'paste' })
    expect(terminalKeyAction(key('Insert', { shiftKey: true }), 'win32', idle)).toEqual({ kind: 'paste' })
    expect(terminalKeyAction(key('v', { ctrlKey: true, altKey: true }), 'win32', idle)).toBeNull()
  })

  it('macOS の ⌘C / ⌘V / Ctrl+C はメニューと xterm に任せる', () => {
    expect(terminalKeyAction(key('c', { metaKey: true }), 'darwin', selected)).toBeNull()
    expect(terminalKeyAction(key('v', { metaKey: true }), 'darwin', idle)).toBeNull()
    expect(terminalKeyAction(key('c', { ctrlKey: true }), 'darwin', selected)).toBeNull()
  })

  it('macOS: ⌘← / ⌘→ / ⌘⌫ は行頭・行末・行頭まで削除、⌥⌦ は次の単語を削除', () => {
    expect(terminalKeyAction(key('ArrowLeft', { metaKey: true }), 'darwin', idle)).toEqual({ kind: 'send', data: '\x01' })
    expect(terminalKeyAction(key('ArrowRight', { metaKey: true }), 'darwin', idle)).toEqual({ kind: 'send', data: '\x05' })
    expect(terminalKeyAction(key('Backspace', { metaKey: true }), 'darwin', idle)).toEqual({ kind: 'send', data: '\x15' })
    expect(terminalKeyAction(key('Delete', { altKey: true }), 'darwin', idle)).toEqual({ kind: 'send', data: '\x1bd' })
    // ほかの OS では Meta / Alt の組み合わせを横取りしない
    expect(terminalKeyAction(key('ArrowLeft', { metaKey: true }), 'linux', idle)).toBeNull()
    expect(terminalKeyAction(key('Delete', { altKey: true }), 'win32', idle)).toBeNull()
  })
})

describe('ターミナルの最低コントラスト（Orca #2830 #10104）', () => {
  it('明るい地は 4.5、暗い地は 3（tokens.css の --term-bg）', () => {
    expect(minimumContrastFor('#ffffff')).toBe(LIGHT_BG_MIN_CONTRAST)
    expect(minimumContrastFor('#0f0f0f')).toBe(DARK_BG_MIN_CONTRAST)
    expect(minimumContrastFor('#fff')).toBe(LIGHT_BG_MIN_CONTRAST)
  })

  it('読めない色は暗い地として扱う（補正を強くしすぎない）', () => {
    expect(relativeLuminance('rgb(1,2,3)')).toBeNull()
    expect(minimumContrastFor('')).toBe(DARK_BG_MIN_CONTRAST)
  })
})
