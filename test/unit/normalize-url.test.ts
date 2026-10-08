import { describe, expect, it } from 'vitest'
import { addressBarUrl, normalizeUrl } from '../../src/shared/projectUrl'

describe('normalizeUrl', () => {
  it('スキームなしのホスト:ポートに http:// を補う（localhost: をスキームと読まない）', () => {
    expect(normalizeUrl('localhost:3000/pricing')).toBe('http://localhost:3000/pricing')
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('127.0.0.1:5173?x=1')).toBe('http://127.0.0.1:5173?x=1')
    expect(normalizeUrl('example.com:8080#top')).toBe('http://example.com:8080#top')
  })

  it('スキーム付きはそのまま', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
    expect(normalizeUrl('mailto:a@example.com')).toBe('mailto:a@example.com')
  })

  it('ホスト名だけ・絶対パス・空', () => {
    expect(normalizeUrl(' example.com/a ')).toBe('http://example.com/a')
    expect(normalizeUrl('/tmp/index.html')).toBe('file:///tmp/index.html')
    expect(normalizeUrl('')).toBe('about:blank')
  })
})

describe('addressBarUrl（URL 欄：URL の形でなければ Google で検索）', () => {
  const q = (s: string) => `https://www.google.com/search?q=${encodeURIComponent(s)}`
  it('URL の形はそのまま開く', () => {
    expect(addressBarUrl('localhost:3000/pricing')).toBe('http://localhost:3000/pricing')
    expect(addressBarUrl('localhost')).toBe('http://localhost')
    expect(addressBarUrl('app.localhost/x')).toBe('http://app.localhost/x')
    expect(addressBarUrl('gmail.com')).toBe('http://gmail.com')
    expect(addressBarUrl('mail.google.com/mail/u/0/')).toBe('http://mail.google.com/mail/u/0/')
    expect(addressBarUrl('192.168.0.10/admin')).toBe('http://192.168.0.10/admin')
    expect(addressBarUrl('[::1]/x')).toBe('http://[::1]/x')
    expect(addressBarUrl('日本語.jp')).toBe('http://日本語.jp')
    expect(addressBarUrl('xn--wgv71a.xn--zckzah/')).toBe('http://xn--wgv71a.xn--zckzah/')
    expect(addressBarUrl('https://example.com/a b')).toBe('https://example.com/a b')
    expect(addressBarUrl('https://example.com')).toBe('https://example.com')
    expect(addressBarUrl('about:blank')).toBe('about:blank')
    expect(addressBarUrl('/tmp/index.html')).toBe('file:///tmp/index.html')
    expect(addressBarUrl('')).toBe('about:blank')
    // 開けないスキームは検索に変えず、今までどおり開く側で断る
    expect(addressBarUrl('javascript:alert(1)')).toBe('javascript:alert(1)')
    expect(addressBarUrl('zoommtg://join')).toBe('zoommtg://join')
  })
  it('言葉・空白を含む入力・ドットの無い名前・知らない「名前:」は Google で検索する', () => {
    expect(addressBarUrl('gmail')).toBe(q('gmail'))
    expect(addressBarUrl('ferret ade')).toBe(q('ferret ade'))
    expect(addressBarUrl('東京 天気')).toBe(q('東京 天気'))
    expect(addressBarUrl('react useEffect cleanup')).toBe(q('react useEffect cleanup'))
    expect(addressBarUrl('node.js')).toBe(q('node.js'))
    expect(addressBarUrl('package.json')).toBe(q('package.json'))
    expect(addressBarUrl('v1.2.3')).toBe(q('v1.2.3'))
    expect(addressBarUrl('c++:templates')).toBe(q('c++:templates'))
    expect(addressBarUrl('?example.com')).toBe(q('example.com'))
    expect(addressBarUrl('a&b=c')).toBe(q('a&b=c'))
  })
})
