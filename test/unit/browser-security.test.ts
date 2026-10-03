/**
 * 内蔵ブラウザの配線そのものを確かめる（security-2 [4] [11]）。
 * electron を差し替え、browser.ts が「読み込みの前に権限の決まりを入れる」「OS の URL ハンドラへ渡さない」ことを見る。
 * ページの中でマイク・カメラを求める調べはしない（ハンドラを直接呼ぶ）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  order: [] as string[],
  requestHandler: null as null | ((wc: unknown, permission: string, cb: (g: boolean) => void, details: Record<string, unknown>) => void),
  checkHandler: null as null | ((wc: unknown, permission: string, origin: string, details: Record<string, unknown>) => boolean),
  openExternal: [] as string[],
  dialogs: [] as string[],
  dialogResponse: 1,
  windowOpen: null as null | ((d: { url: string }) => { action: string }),
  events: new Map<string, (...args: unknown[]) => void>(),
  loaded: [] as string[],
  currentUrl: 'https://evil.example/page'
}))

vi.mock('electron', () => {
  const fakeSession = {
    setPermissionRequestHandler: (h: typeof state.requestHandler) => { state.order.push('request-handler'); state.requestHandler = h },
    setPermissionCheckHandler: (h: typeof state.checkHandler) => { state.order.push('check-handler'); state.checkHandler = h },
    getUserAgent: () => 'UA'
  }
  class WebContentsView {
    webContents = {
      session: fakeSession,
      isDestroyed: () => false,
      setWindowOpenHandler: (h: typeof state.windowOpen) => { state.windowOpen = h },
      on: (name: string, fn: (...args: unknown[]) => void) => { state.events.set(name, fn) },
      loadURL: async (url: string) => { state.loaded.push(url) },
      getURL: () => state.currentUrl,
      getTitle: () => '',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
    constructor(options: { webPreferences: { session: unknown } }) {
      state.order.push(options.webPreferences.session === fakeSession ? 'view-with-policy-session' : 'view-with-other-session')
    }
    setBackgroundColor(): void {}
    setBounds(): void {}
  }
  return {
    WebContentsView,
    session: { fromPartition: () => fakeSession },
    shell: { openExternal: async (url: string) => { state.openExternal.push(url) } },
    dialog: { showMessageBox: async (...args: unknown[]) => { state.dialogs.push(String((args.at(-1) as { detail?: string }).detail)); return { response: state.dialogResponse } } }
  }
})

const { EmbeddedBrowser, browserSession } = await import('../../src/main/browser')

const flush = () => new Promise((r) => setTimeout(r, 0))
const request = (permission: string, details: Record<string, unknown>) => new Promise<boolean>((resolve) => state.requestHandler!({}, permission, resolve, details))

function attach(): void {
  const window = { contentView: { addChildView: () => {}, removeChildView: () => {} }, isDestroyed: () => false } as unknown as Parameters<InstanceType<typeof EmbeddedBrowser>['attach']>[0]
  new EmbeddedBrowser().attach(window, 'https://evil.example/page', 'desktop')
}

beforeEach(() => {
  state.openExternal.length = 0
  state.dialogs.length = 0
  state.dialogResponse = 1
  state.loaded.length = 0
})

describe('security-2 [4] 内蔵ブラウザの権限', () => {
  it('ビューを作る（読み込む）前に、request と check の両方のハンドラを入れる', () => {
    attach()
    const view = state.order.indexOf('view-with-policy-session')
    expect(view).toBeGreaterThan(-1)
    expect(state.order.indexOf('request-handler')).toBeLessThan(view)
    expect(state.order.indexOf('check-handler')).toBeLessThan(view)
  })

  it('レビューするページのマイク・カメラ・画面共有・位置・通知・クリップボードの読み取り・USB などは断る（session を使い回しても同じ）', async () => {
    browserSession()
    browserSession()
    const page = { requestingUrl: 'https://evil.example/page', isMainFrame: true, securityOrigin: 'https://evil.example' }
    expect(await request('media', { ...page, mediaTypes: ['audio'] })).toBe(false)
    expect(await request('media', { ...page, mediaTypes: ['video'] })).toBe(false)
    for (const p of ['display-capture', 'geolocation', 'notifications', 'clipboard-read', 'midiSysex', 'usb', 'hid', 'serial', 'local-network-access', 'pointerLock', 'something-new']) {
      expect(await request(p, page), p).toBe(false)
      expect(state.checkHandler!({}, p, 'https://evil.example', page), p).toBe(false)
    }
    expect(state.checkHandler!({}, 'media', 'https://evil.example', { ...page, mediaType: 'audio' })).toBe(false)
  })
})

describe('security-2 [11] 内蔵ブラウザから OS の URL ハンドラへ渡さない', () => {
  const HOSTILE = ['zoommtg://zoom.us/join?confno=1', 'file:///etc/passwd', 'smb://attacker.example/share', 'data:text/html,<script>1</script>',
    'x-apple.systempreferences:com.apple.preference.security', 'ms-settings:privacy', 'javascript:alert(1)', 'vscode://file/etc/hosts']

  it('window.open の独自・file・SMB・data・OS 設定のスキームは openExternal を呼ばず、確認も出さない', async () => {
    attach()
    for (const url of HOSTILE) expect(state.windowOpen!({ url }).action).toBe('deny')
    await flush()
    expect(state.openExternal).toEqual([])
    expect(state.dialogs).toEqual([])
    // http(s) は同じビューで開く（外へは出さない）
    state.windowOpen!({ url: 'https://example.com/next' })
    expect(state.loaded).toContain('https://example.com/next')
  })

  it('ページの遷移と転送（リダイレクト）でも、行けない先は止める', async () => {
    attach()
    for (const name of ['will-navigate', 'will-redirect']) {
      for (const url of HOSTILE) {
        const event = { url, preventDefault: vi.fn() }
        state.events.get(name)!(event)
        expect(event.preventDefault, `${name} ${url}`).toHaveBeenCalled()
      }
      const ok = { url: 'https://example.com/', preventDefault: vi.fn() }
      state.events.get(name)!(ok)
      expect(ok.preventDefault).not.toHaveBeenCalled()
    }
    await flush()
    expect(state.openExternal).toEqual([])
  })

  it('リンク・転送からの外部アプリの起動（openExternal の権限）は断り、独自スキームは確認も出さない', async () => {
    browserSession()
    expect(await request('openExternal', { requestingUrl: 'https://evil.example/page', externalURL: 'zoommtg://zoom.us/join' })).toBe(false)
    expect(await request('openExternal', { requestingUrl: 'https://evil.example/page', externalURL: 'smb://attacker.example/share' })).toBe(false)
    await flush()
    expect(state.openExternal).toEqual([])
    expect(state.dialogs).toEqual([])
  })

  it('mailto は、行き先とページを見せた確認で「開く」を選んだときだけ渡す', async () => {
    attach()
    state.windowOpen!({ url: 'mailto:a@example.com' })
    await flush()
    expect(state.dialogs).toHaveLength(1)
    expect(state.dialogs[0]).toContain('mailto:a@example.com')
    expect(state.dialogs[0]).toContain('https://evil.example')
    expect(state.openExternal).toEqual([])
    state.dialogResponse = 0
    state.windowOpen!({ url: 'mailto:a@example.com' })
    await flush()
    expect(state.openExternal).toEqual(['mailto:a@example.com'])
  })
})
