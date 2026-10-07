import { describe, expect, it } from 'vitest'
import { BrowserIdentity, ELECTRON_UA_HOSTS_MAX, cleanElectronUserAgent, electronUserAgent, isCloudflareChallenge } from '../../src/main/browserUserAgent'

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

const NATIVE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ade-movie/0.4.18 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36'
const CHROME = cleanElectronUserAgent(NATIVE)
const ELECTRON = electronUserAgent(NATIVE)
const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const challenge = { 'cf-mitigated': ['challenge'] }

describe('Cloudflare の人間チェックを返したホストは Electron の UA で開く', () => {
  it('Electron の印は残してアプリの印だけ外す', () => {
    expect(ELECTRON).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36')
  })

  it('cf-mitigated: challenge を名前の大小を問わず見分ける', () => {
    expect(isCloudflareChallenge({ 'CF-Mitigated': 'challenge' })).toBe(true)
    expect(isCloudflareChallenge(challenge)).toBe(true)
    expect(isCloudflareChallenge({ 'cf-ray': ['abc'] })).toBe(false)
    expect(isCloudflareChallenge(undefined)).toBe(false)
  })

  it('確認を返したホストを覚え、1回だけ開き直す（ループしない）', () => {
    const id = new BrowserIdentity(CHROME, ELECTRON)
    const res = { url: 'https://nyusatsu-open.ai/', resourceType: 'mainFrame', sentUserAgent: CHROME, headers: challenge }
    expect(id.userAgentFor(res.url)).toBe(CHROME)
    expect(id.noteResponse(res)).toBe(true)
    expect(id.userAgentFor('https://nyusatsu-open.ai/search?q=1')).toBe(ELECTRON)
    // 同じホストで2回目・Electron の UA でも確認が出たときは開き直さない
    expect(id.noteResponse(res)).toBe(false)
    expect(id.noteResponse({ ...res, sentUserAgent: ELECTRON })).toBe(false)
    // ほかのホストは Chrome の形のまま（Google のログインが簡易版に落ちない）
    expect(id.userAgentFor('https://accounts.google.com/')).toBe(CHROME)
  })

  it('確認でない応答・ページ本体でない応答・モバイルの表示の UA では切り替えない', () => {
    const id = new BrowserIdentity(CHROME, ELECTRON)
    expect(id.noteResponse({ url: 'https://a.example/', resourceType: 'mainFrame', sentUserAgent: CHROME, headers: { 'cf-ray': 'x' } })).toBe(false)
    expect(id.noteResponse({ url: 'https://a.example/', resourceType: 'subFrame', sentUserAgent: CHROME, headers: challenge })).toBe(false)
    expect(id.noteResponse({ url: 'https://a.example/', resourceType: 'mainFrame', sentUserAgent: MOBILE, headers: challenge })).toBe(false)
    expect(id.noteResponse({ url: 'file:///etc/hosts', resourceType: 'mainFrame', sentUserAgent: CHROME, headers: challenge })).toBe(false)
    expect(id.userAgentFor('https://a.example/')).toBe(CHROME)
  })

  it('ページ本体のリクエストの UA を行き先に合わせ、モバイルの表示の UA・ほかの種類には手を出さない', () => {
    const id = new BrowserIdentity(CHROME, ELECTRON)
    id.noteResponse({ url: 'https://cf.example/', resourceType: 'mainFrame', sentUserAgent: CHROME, headers: challenge })
    expect(id.requestUserAgent({ url: 'https://cf.example/next', resourceType: 'mainFrame', currentUserAgent: CHROME })).toBe(ELECTRON)
    expect(id.requestUserAgent({ url: 'https://other.example/', resourceType: 'mainFrame', currentUserAgent: ELECTRON })).toBe(CHROME)
    expect(id.requestUserAgent({ url: 'https://other.example/', resourceType: 'mainFrame', currentUserAgent: CHROME })).toBeNull()
    expect(id.requestUserAgent({ url: 'https://cf.example/a.js', resourceType: 'script', currentUserAgent: CHROME })).toBeNull()
    expect(id.requestUserAgent({ url: 'https://cf.example/', resourceType: 'mainFrame', currentUserAgent: MOBILE })).toBeNull()
  })

  it('覚えるホストの数に上限がある（古いものから忘れる）', () => {
    const id = new BrowserIdentity(CHROME, ELECTRON)
    for (let i = 0; i <= ELECTRON_UA_HOSTS_MAX; i++) id.noteResponse({ url: `https://h${i}.example/`, resourceType: 'mainFrame', sentUserAgent: CHROME, headers: challenge })
    expect(id.userAgentFor('https://h0.example/')).toBe(CHROME)
    expect(id.userAgentFor(`https://h${ELECTRON_UA_HOSTS_MAX}.example/`)).toBe(ELECTRON)
  })
})
