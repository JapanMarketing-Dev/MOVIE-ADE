import { describe, expect, it, vi } from 'vitest'
import { normalizeThemePreference } from '@shared/theme'

// settings.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))
const { sanitize } = await import('../../src/main/settings')

describe('配色の設定', () => {
  it('保存値は system / light / dark のどれかに直す', () => {
    expect(sanitize({ theme: 'light' }).theme).toBe('light')
    expect(sanitize({ theme: 'dark' }).theme).toBe('dark')
    expect(sanitize({ theme: 'system' }).theme).toBe('system')
    expect(sanitize({}).theme).toBe('system')
    expect(sanitize({ theme: 'sepia' }).theme).toBe('system')
    expect(normalizeThemePreference(1)).toBe('system')
  })
})
