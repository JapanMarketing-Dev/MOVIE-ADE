import { afterEach, describe, expect, it, vi } from 'vitest'

/** macOS のウインドウメニュー（Orca #21281 #20837）。Windows / Linux には置かない（Ctrl+M を奪わない） */
const built = vi.hoisted(() => ({ template: [] as Array<{ label?: string; role?: string; submenu?: Array<{ role?: string }> }> }))
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: typeof built.template) => { built.template = template; return {} },
    setApplicationMenu: () => undefined
  }
}))

const realPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  vi.resetModules()
})

async function templateFor(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
  const { installMenu } = await import('../../src/main/menu')
  installMenu({ onOpenFolder: () => undefined, onCommand: () => undefined })
  return built.template
}

describe('ウインドウメニュー', () => {
  it('macOS ではヘルプの前に置き、しまう（⌘M）・拡大/縮小・すべてを手前に を入れる', async () => {
    const template = await templateFor('darwin')
    const index = template.findIndex((item) => item.role === 'window')
    expect(index).toBeGreaterThan(0)
    expect(template[index + 1]?.role).toBe('help')
    expect(template[index]!.submenu!.map((item) => item.role).filter(Boolean)).toEqual(['minimize', 'zoom', 'front'])
  })

  it('Windows / Linux には置かない', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const template = await templateFor(platform)
      expect(template.some((item) => item.role === 'window')).toBe(false)
    }
  })
})
