import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalOwnsMenuKey, type MenuKeyInput } from '@shared/terminalMenuKeys'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '@shared/bracketedPaste'
import { windowsAgentPasteData } from '../../src/renderer/terminal/terminalKeys'

type Item = { label?: string; role?: string; accelerator?: string; registerAccelerator?: boolean; submenu?: Item[] }
const built = vi.hoisted(() => ({ template: [] as Item[] }))
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: Item[]) => { built.template = template; return {} },
    setApplicationMenu: () => undefined
  }
}))

const realPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  vi.resetModules()
})

async function acceleratorsFor(platform: NodeJS.Platform): Promise<string[]> {
  Object.defineProperty(process, 'platform', { value: platform })
  const { installMenu } = await import('../../src/main/menu')
  installMenu({ onOpenFolder: () => undefined, onCommand: () => undefined })
  const walk = (items: Item[]): Item[] => items.flatMap((item) => [item, ...walk(item.submenu ?? [])])
  return walk(built.template).filter((item) => item.accelerator && item.registerAccelerator !== false).map((item) => item.accelerator!)
}

/** Electron の accelerator（CmdOrCtrl+Shift+R）を、before-input-event の input の形にする（Windows / Linux） */
function inputOf(accelerator: string): MenuKeyInput {
  const parts = accelerator.split('+')
  const key = parts.pop()!
  const has = (name: string) => parts.some((p) => p.toLowerCase() === name)
  return { key: key.length === 1 ? key.toLowerCase() : key, control: has('cmdorctrl') || has('ctrl') || has('control'), meta: has('cmd') || has('command'), alt: has('alt'), shift: has('shift') }
}

const ctrl = (key: string, mods: Partial<MenuKeyInput> = {}): MenuKeyInput => ({ key, control: true, meta: false, alt: false, shift: false, ...mods })

describe('ターミナルのキーをメニューに取らせない（Orca #11540）', () => {
  it('Windows / Linux: Ctrl+英字（tmux の Ctrl+B、readline の Ctrl+R・Ctrl+W・Ctrl+A、中断の Ctrl+C）はターミナルへ', () => {
    for (const platform of ['win32', 'linux']) {
      for (const key of ['b', 'r', 'w', 'a', 'c', 'l', 'o', 'p', 's', 't', 'v', 'z', 'x', 'y', ',']) expect(terminalOwnsMenuKey(ctrl(key), platform), `${platform} Ctrl+${key}`).toBe(true)
      // ターミナルのコピー・貼り付け
      expect(terminalOwnsMenuKey(ctrl('C', { shift: true }), platform)).toBe(true)
      expect(terminalOwnsMenuKey(ctrl('V', { shift: true }), platform)).toBe(true)
    }
  })

  it('Ctrl+Shift の画面の切り替え（録画・モードなど）と、Ctrl の無いキーはメニューのまま', () => {
    for (const key of ['R', 'M', 'E', 'K', 'U']) expect(terminalOwnsMenuKey(ctrl(key, { shift: true }), 'win32')).toBe(false)
    expect(terminalOwnsMenuKey({ key: 'ArrowLeft', control: false, meta: false, alt: true, shift: false }, 'linux')).toBe(false)
    expect(terminalOwnsMenuKey({ key: 'F11', control: false, meta: false, alt: false, shift: false }, 'win32')).toBe(false)
  })

  it('macOS はメニューが ⌘ なので何もしない', () => {
    expect(terminalOwnsMenuKey(ctrl('r'), 'darwin')).toBe(false)
    expect(terminalOwnsMenuKey({ key: 'w', control: false, meta: true, alt: false, shift: false }, 'darwin')).toBe(false)
  })

  it('Windows / Linux のメニューの Ctrl+英字の accelerator は、どれもターミナルのフォーカス中はターミナルへ渡る', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const plain = (await acceleratorsFor(platform)).map(inputOf).filter((i) => i.control && !i.shift && !i.alt && !i.meta)
      expect(plain.map((i) => i.key)).toEqual(expect.arrayContaining(['o', 'p', 's', 'l', 'r', 't', 'w']))
      for (const input of plain) expect(terminalOwnsMenuKey(input, platform), `${platform} Ctrl+${input.key}`).toBe(true)
    }
  })
})

describe('Windows で Agent へ複数行を貼る（Orca #5274）', () => {
  const agent = { agentForeground: true, bracketedPasteMode: false }

  it('改行を含むときはブラケットペーストで包み、改行は CR にする', () => {
    expect(windowsAgentPasteData('line 1\r\nline 2\nline 3', 'win32', agent)).toBe(`${BRACKETED_PASTE_START}line 1\rline 2\rline 3${BRACKETED_PASTE_END}`)
  })

  it('本文の中の枠の印は消す（貼った文字で枠を閉じて後ろを実行させない）', () => {
    expect(windowsAgentPasteData(`a\n${BRACKETED_PASTE_END}rm -rf ~\n${BRACKETED_PASTE_START}b`, 'win32', agent)).toBe(`${BRACKETED_PASTE_START}a\rrm -rf ~\rb${BRACKETED_PASTE_END}`)
  })

  it('1行・シェルだけ・xterm が既に包む・Windows 以外は xterm に任せる', () => {
    expect(windowsAgentPasteData('one line', 'win32', agent)).toBeNull()
    expect(windowsAgentPasteData('a\nb', 'win32', { agentForeground: false, bracketedPasteMode: false })).toBeNull()
    expect(windowsAgentPasteData('a\nb', 'win32', { agentForeground: true, bracketedPasteMode: true })).toBeNull()
    for (const platform of ['darwin', 'linux']) expect(windowsAgentPasteData('a\nb', platform, agent)).toBeNull()
  })
})
