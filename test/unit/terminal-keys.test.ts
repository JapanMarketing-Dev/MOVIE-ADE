import { describe, expect, it, vi } from 'vitest'
import { agentNewlineData, foregroundAgentOf, freshForegroundAgent, terminalKeyAction, type TerminalKeyEvent } from '../../src/renderer/terminal/terminalKeys'
import { InputHold } from '../../src/renderer/terminal/inputHold'
import { DARK_BG_MIN_CONTRAST, LIGHT_BG_MIN_CONTRAST, minimumContrastFor, relativeLuminance } from '../../src/renderer/terminal/terminalContrast'

function key(k: string, mods: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }
}
const idle = { hasSelection: false }
const agent = idle
const selected = { hasSelection: true }

describe('ターミナルで xterm より先に受けるキー（Orca #2412 #5611 #560 #5797 #21491）', () => {
  it('Shift+Enter はどの OS でも改行の扱い（送るキー列は前面の Agent で決める）', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(terminalKeyAction(key('Enter', { shiftKey: true }), platform, idle)).toEqual({ kind: 'newline' })
    }
  })

  it('ほかの修飾キー付きの Enter は xterm に任せる', () => {
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

describe('Shift+Enter で Agent ごとに送る改行のキー列', () => {
  it('Ctrl+J（LF）で改行するのを確かめた Agent には LF（ESC で中断しない）', () => {
    for (const id of ['claude', 'codex', 'gemini', 'qwen-code', 'cursor', 'crush', 'kimi'] as const) expect(agentNewlineData(id)).toBe('\n')
  })

  it('Meta+Enter で改行する Agent（LF が送信になる aider など）と、確かめていない・登録した Agent には ESC+CR を1つの文字列で', () => {
    for (const id of ['aider', 'copilot', 'opencode', 'amp', 'custom:my-agent'] as const) expect(agentNewlineData(id)).toBe('\x1b\r')
  })

  it('Agent が前面にいなければ Enter と同じ CR（シェルでは実行）', () => {
    expect(agentNewlineData(null)).toBe('\r')
  })

  it('agentState の返事から前面の Agent を取り出す', () => {
    expect(foregroundAgentOf({ kind: 'codex', state: 'idle', agent: 'codex' } as never)).toBe('codex')
    expect(foregroundAgentOf({ kind: 'unknown', agent: null })).toBeNull()
    expect(foregroundAgentOf(null)).toBeNull()
  })
})

describe('前面の判定の遅れ（1秒ごとの問い合わせ）を埋める', () => {
  it('その場の問い合わせで Agent が分かれば、最後に分かった状態がシェルでもその Agent', async () => {
    await expect(freshForegroundAgent(async () => ({ kind: 'claude-code', agent: 'claude' }), null, 1500)).resolves.toBe('claude')
  })

  it('問い合わせが失敗・時間切れなら最後に分かった状態に倒す', async () => {
    await expect(freshForegroundAgent(() => Promise.reject(new Error('closed')), null, 1500)).resolves.toBeNull()
    vi.useFakeTimers()
    try {
      const pending = freshForegroundAgent(() => new Promise(() => {}), 'codex', 1500)
      vi.advanceTimersByTime(1500)
      await expect(pending).resolves.toBe('codex')
    } finally {
      vi.useRealTimers()
    }
  })

  it('キー列が決まるまでの打鍵はためて、決まったら順番どおりに1回で送る', async () => {
    const writes: string[] = []
    const hold = new InputHold((data) => writes.push(data))
    hold.send('a')
    let resolve!: (value: string) => void
    hold.send(new Promise<string>((r) => { resolve = r }))
    hold.send('b')
    hold.send('c')
    expect(writes).toEqual(['a'])
    expect(hold.holding).toBe(true)
    resolve('\n')
    await vi.waitFor(() => expect(writes).toEqual(['a', '\nbc']))
    expect(hold.holding).toBe(false)
    hold.send('d')
    expect(writes).toEqual(['a', '\nbc', 'd'])
  })

  it('続けて2回待っても順番は変わらない', async () => {
    const writes: string[] = []
    const hold = new InputHold((data) => writes.push(data))
    let first!: (value: string) => void
    hold.send(new Promise<string>((r) => { first = r }))
    hold.send('x')
    hold.send(Promise.resolve('\r'))
    hold.send('y')
    first('\x1b\r')
    await vi.waitFor(() => expect(writes.join('')).toBe('\x1b\rx\ry'))
    expect(writes[0].startsWith('\x1b\r')).toBe(true)
  })
})
