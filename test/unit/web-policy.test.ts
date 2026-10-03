/**
 * 内蔵ブラウザ・メインウィンドウの権限と、外部アプリへの受け渡しの決まり（レポート [3] [7]）。
 * Electron は使わず、session の権限ハンドラの形だけを持つ偽物に入れて確かめる
 */
import { describe, expect, it, vi } from 'vitest'
import {
  APP_ALLOWED_PERMISSIONS,
  createExternalOpener,
  installPermissionPolicy,
  isAllowedExternalUrl,
  isAppPageUrl,
  isPageNavigationAllowed,
  isTabCaptureRequest,
  isTypedNavigationAllowed,
  windowOpenAction,
  type PermissionDetails,
  type PermissionSessionLike
} from '../../src/main/webPolicy'

type RequestHandler = Parameters<PermissionSessionLike['setPermissionRequestHandler']>[0]
type CheckHandler = Parameters<PermissionSessionLike['setPermissionCheckHandler']>[0]

function fakeSession() {
  let request: RequestHandler = null
  let check: CheckHandler = null
  const ses: PermissionSessionLike = {
    setPermissionRequestHandler: (h) => { request = h },
    setPermissionCheckHandler: (h) => { check = h }
  }
  return {
    ses,
    request(permission: string, details: PermissionDetails = {}): boolean {
      let granted: boolean | undefined
      request!({}, permission, (g) => { granted = g }, details)
      if (granted === undefined) throw new Error('callback not called')
      return granted
    },
    check(permission: string, origin: string, details: PermissionDetails = {}): boolean {
      return check!({}, permission, origin, details)
    },
    get installed() { return request !== null && check !== null }
  }
}

/** 敵対的なページが求めそうな権限（Electron の権限名） */
const HOSTILE = ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write',
  'display-capture', 'pointerLock', 'fullscreen', 'openExternal', 'hid', 'serial', 'usb', 'idle-detection', 'storage-access',
  'window-management', 'speaker-selection', 'keyboardLock', 'fileSystem', 'unknown-future-permission']

const PAGE = 'https://evil.example/page'

describe('security-2 [4] 権限の決まり（既定で拒否）', () => {
  it('許すものを指定しなければ、request も check もすべて断る', () => {
    const s = fakeSession()
    installPermissionPolicy(s.ses)
    expect(s.installed).toBe(true)
    for (const p of HOSTILE) {
      expect(s.request(p, { requestingUrl: PAGE, isMainFrame: true, mediaTypes: ['audio', 'video'] }), p).toBe(false)
      expect(s.check(p, 'https://evil.example', { requestingUrl: PAGE, isMainFrame: true }), p).toBe(false)
    }
  })

  it('内蔵ブラウザの決まり（コピーだけ）では、マイク・カメラ・位置・通知・MIDI・画面共有を断る', () => {
    const s = fakeSession()
    installPermissionPolicy(s.ses, ({ permission }) => permission === 'clipboard-sanitized-write')
    for (const p of HOSTILE.filter((p) => p !== 'clipboard-sanitized-write')) {
      expect(s.request(p, { requestingUrl: PAGE, mediaTypes: ['audio'] }), p).toBe(false)
    }
    expect(s.request('clipboard-sanitized-write', { requestingUrl: PAGE })).toBe(true)
  })

  it('録画ウインドウからのタブ録画（機器なし・file: のアプリから）だけを通し、ページ自身のマイク・カメラは通さない', () => {
    const s = fakeSession()
    installPermissionPolicy(s.ses, (q) => q.permission === 'clipboard-sanitized-write' || isTabCaptureRequest(q))
    // 実際に Electron 44 で録画したときに届いた形
    expect(s.request('media', { isMainFrame: true, mediaTypes: [], requestingUrl: PAGE, securityOrigin: 'file:///' })).toBe(true)
    expect(s.request('media', { isMainFrame: true, mediaTypes: ['audio'], requestingUrl: PAGE, securityOrigin: 'file:///' })).toBe(false)
    expect(s.request('media', { isMainFrame: true, mediaTypes: ['video'], requestingUrl: PAGE, securityOrigin: 'https://evil.example' })).toBe(false)
    expect(s.request('media', { isMainFrame: true, mediaTypes: [], requestingUrl: PAGE, securityOrigin: 'https://evil.example' })).toBe(false)
    expect(s.check('media', 'file:///', { requestingUrl: PAGE, securityOrigin: 'file:///', mediaType: 'video' })).toBe(false)
  })

  it('外部アプリの起動（openExternal）は許さず、確認付きの道へ回す', () => {
    const s = fakeSession()
    const onOpen = vi.fn()
    installPermissionPolicy(s.ses, () => true, onOpen)
    expect(s.request('openExternal', { requestingUrl: PAGE, externalURL: 'zoommtg://join?x=1' })).toBe(false)
    expect(onOpen).toHaveBeenCalledWith('zoommtg://join?x=1', PAGE)
    expect(s.check('openExternal', PAGE)).toBe(false)
  })

  it('判定が投げたら断る', () => {
    const s = fakeSession()
    installPermissionPolicy(s.ses, () => { throw new Error('boom') })
    expect(s.request('media', { requestingUrl: PAGE })).toBe(false)
  })

  it('アプリの画面の決まり：アプリ自身の本体のフレームだけにマイク・録画を許し、プレビューの iframe や落としたファイルには許さない', () => {
    const roots = ['file:///Applications/Ferret.app/Contents/Resources/app.asar', 'http://localhost:5173']
    const s = fakeSession()
    installPermissionPolicy(s.ses, ({ permission, origin, isMainFrame }) =>
      APP_ALLOWED_PERMISSIONS.has(permission) && isMainFrame !== false && isAppPageUrl(origin, roots))
    const renderer = 'file:///Applications/Ferret.app/Contents/Resources/app.asar/out/renderer/index.html'
    expect(s.request('media', { requestingUrl: renderer, isMainFrame: true, mediaTypes: ['audio'] })).toBe(true)
    expect(s.request('media', { requestingUrl: 'http://localhost:5173/', isMainFrame: true })).toBe(true)
    // check は file: のページだとオリジンが file:/// になる。フレームの URL で判定する
    expect(s.check('media', 'file:///', { requestingUrl: renderer, isMainFrame: true })).toBe(true)
    expect(s.request('media', { requestingUrl: 'ade-preview://project/index.html', isMainFrame: false })).toBe(false)
    expect(s.request('media', { requestingUrl: renderer, isMainFrame: false })).toBe(false)
    expect(s.request('media', { requestingUrl: 'file:///Users/me/Downloads/dropped.html', isMainFrame: true })).toBe(false)
    expect(s.request('geolocation', { requestingUrl: renderer, isMainFrame: true })).toBe(false)
  })
})

describe('security-2 [11] 外部アプリへの受け渡し', () => {
  it('http / https / mailto だけを許し、file: data: javascript: 独自スキームは断る', () => {
    for (const ok of ['https://example.com/a', 'http://localhost:3000', 'mailto:a@example.com']) expect(isAllowedExternalUrl(ok), ok).toBe(true)
    for (const ng of ['file:///etc/passwd', 'data:text/html,<b>x</b>', 'javascript:alert(1)', 'zoommtg://zoom.us/join', 'smb://host/share',
      'ms-msdt:/id', 'x-apple.systempreferences:com.apple', 'vscode://file/etc', 'https://user:pass@example.com', 'not a url', '']) {
      expect(isAllowedExternalUrl(ng), ng).toBe(false)
    }
  })

  it('window.open：http(s) は内蔵ブラウザで、mailto は確認へ、ほかは何もしない', () => {
    expect(windowOpenAction('https://example.com')).toBe('in-app')
    expect(windowOpenAction('mailto:a@example.com')).toBe('external')
    for (const ng of ['file:///etc/hosts', 'data:text/html,x', 'javascript:void(0)', 'zoommtg://x', 'ade-preview://p/x']) {
      expect(windowOpenAction(ng), ng).toBe('deny')
    }
  })

  it('許可リストに無いものは、確認も開くこともしない', async () => {
    const confirm = vi.fn(async () => true)
    const open = vi.fn(async () => undefined)
    const opener = createExternalOpener({ confirm, open })
    for (const url of ['file:///etc/passwd', 'data:text/html,x', 'zoommtg://x', 'javascript:alert(1)']) {
      expect(await opener(url, PAGE)).toBe(false)
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('mailto は確認して利用者が選んだときだけ開く。確認中に来たものは捨てる', async () => {
    let answer: (v: boolean) => void = () => {}
    const confirm = vi.fn(() => new Promise<boolean>((r) => { answer = r }))
    const open = vi.fn(async () => undefined)
    const opener = createExternalOpener({ confirm, open })
    const first = opener('mailto:a@example.com', PAGE)
    // 連打（スクリプトからの繰り返し）は確認を積まない
    expect(await opener('mailto:b@example.com', PAGE)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith({ url: 'mailto:a@example.com', origin: PAGE })
    answer(false)
    expect(await first).toBe(false)
    expect(open).not.toHaveBeenCalled()

    const second = opener('mailto:a@example.com', PAGE)
    answer(true)
    expect(await second).toBe(true)
    expect(open).toHaveBeenCalledWith('mailto:a@example.com')
  })
})

describe('security-2 [11] 遷移の決まり', () => {
  it('URL 欄からは http(s)・プレビュー・手元のファイル・空ページだけ', () => {
    for (const ok of ['https://example.com', 'http://localhost:3000', 'file:///Users/me/site/index.html', 'ade-preview://p/README.md', 'about:blank']) {
      expect(isTypedNavigationAllowed(ok), ok).toBe(true)
    }
    for (const ng of ['javascript:alert(1)', 'data:text/html,x', 'zoommtg://x', 'chrome://settings', 'mailto:a@b.c']) {
      expect(isTypedNavigationAllowed(ng), ng).toBe(false)
    }
  })

  it('ページが始めた遷移では、web のページから手元のファイルへは行かせない', () => {
    expect(isPageNavigationAllowed('https://b.example', PAGE)).toBe(true)
    expect(isPageNavigationAllowed('file:///etc/passwd', PAGE)).toBe(false)
    expect(isPageNavigationAllowed('file:///Users/me/site/b.html', 'file:///Users/me/site/a.html')).toBe(true)
    expect(isPageNavigationAllowed('zoommtg://x', PAGE)).toBe(false)
    expect(isPageNavigationAllowed('javascript:alert(1)', PAGE)).toBe(false)
  })

  it('アプリの画面かどうかは、アプリのフォルダの下か開発サーバーかで見る', () => {
    const roots = ['file:///Apps/Ferret%20Dev/app', 'http://localhost:5173']
    expect(isAppPageUrl('file:///Apps/Ferret%20Dev/app/out/renderer/index.html', roots)).toBe(true)
    expect(isAppPageUrl('file:///Apps/Ferret%20Dev/application/evil.html', roots)).toBe(false)
    expect(isAppPageUrl('http://localhost:5173/#/x', roots)).toBe(true)
    expect(isAppPageUrl('http://localhost:5174/', roots)).toBe(false)
    expect(isAppPageUrl('ade-preview://p/index.html', roots)).toBe(false)
  })
})
