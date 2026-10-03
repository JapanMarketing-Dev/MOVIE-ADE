import { describe, expect, it } from 'vitest'
import { normalizeUrl } from '../../src/shared/projectUrl'

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
