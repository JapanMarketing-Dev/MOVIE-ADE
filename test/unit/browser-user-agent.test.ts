import { describe, expect, it } from 'vitest'
import { cleanElectronUserAgent } from '../../src/main/browserUserAgent'

describe('内蔵ブラウザの UA（Orca #6711 #10468 #18562）', () => {
  it('Electron とアプリの印を外して Chrome と同じ形にする', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ferret/0.4.0 Chrome/144.0.7559.60 Electron/44.5.1 Safari/537.36'
    expect(cleanElectronUserAgent(ua)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Safari/537.36')
  })

  it('空白入りのアプリ名（開発版）も外す', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Ferret Dev/0.4.0 Chrome/144.0.0.0 Electron/44.5.1 Safari/537.36'
    expect(cleanElectronUserAgent(ua)).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36')
  })

  it('Chrome の形でない UA（モバイルの表示の UA など）はそのまま', () => {
    expect(cleanElectronUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1')).toBe('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1')
  })
})
