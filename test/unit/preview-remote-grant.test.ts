/// <reference path="../../src/main/preview/raw.d.ts" />
import { describe, expect, it, vi } from 'vitest'

// プロトコルの処理だけを確かめる。同梱のアセットとファイルの読み出しは差し替える
vi.mock('mermaid/dist/mermaid.min.js?asset', () => ({ default: '/dev/null' }))
vi.mock('../../src/main/preview/page.js?raw', () => ({ default: '' }))
vi.mock('../../src/main/preview/page.css?raw', () => ({ default: '' }))
vi.mock('../../src/main/files', () => ({
  readTextFile: async (_root: string, path: string) => ({ kind: 'text', path, content: '![t](https://tracker.example/p.png)\n', mtimeMs: 0 })
}))

const { registerPreviewProtocol } = await import('../../src/main/preview/index')
const { consumeRemoteImagesGrant, issueRemoteImagesGrant, MAX_REMOTE_IMAGES_GRANTS, REMOTE_IMAGES_GRANT_TTL_MS, remoteImagesGrantCount } = await import('../../src/main/preview/remoteGrant')
const { sanitizeProjectSession, withProjectSession } = await import('@shared/projectSession')
const { stripPreviewGrant } = await import('@shared/preview')

type Handler = (request: Request) => Promise<Response>
let handler: Handler | null = null
registerPreviewProtocol([{ protocol: { isProtocolHandled: () => false, handle: (_s: string, h: Handler) => { handler = h } } } as never], () => '/project')

const get = (url: string) => handler!(new Request(url))
const csp = (res: Response) => res.headers.get('Content-Security-Policy') ?? ''
const grant = async (url: string, headers: Record<string, string> = { 'X-Ferret-Remote-Images': 'grant' }) =>
  handler!(new Request(url, { method: 'POST', headers }))

describe('security-4 [6] プレビューの外部の画像の許可は、推測できる URL では作れない', () => {
  it('security-4 [6] Markdown のリンク・手入力の ?remote-images=1 などでは https を許さない', async () => {
    for (const q of ['1', 'true', 'allow', '', 'x'.repeat(32)]) {
      const res = await get(`ade-preview://project/README.md?remote-images=${q}`)
      expect(csp(res), q).not.toMatch(/https:/)
      expect(await res.text()).toContain('data-remote-images="block"')
    }
  })

  it('security-4 [6] ボタンの POST（決めた見出し付き）で受け取った合言葉は、その文書で1回だけ使える', async () => {
    const res = await grant('ade-preview://project/README.md')
    const { token } = (await res.json()) as { token: string }
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    // 別の文書では使えない（使い切る）
    expect(csp(await get(`ade-preview://project/OTHER.md?remote-images=${token}`))).not.toMatch(/https:/)
    const again = await grant('ade-preview://project/README.md')
    const t2 = ((await again.json()) as { token: string }).token
    const allowed = await get(`ade-preview://project/README.md?remote-images=${t2}`)
    expect(csp(allowed)).toMatch(/img-src ade-preview: data: https:/)
    expect(await allowed.text()).toContain('data-remote-images="allow"')
    // 同じ URL を開き直しても（戻る・復元）許可は戻らない
    expect(csp(await get(`ade-preview://project/README.md?remote-images=${t2}`))).not.toMatch(/https:/)
  })

  it('security-4 [6] 見出しの無い POST・GET では合言葉を出さない', async () => {
    const before = remoteImagesGrantCount()
    const res = await grant('ade-preview://project/README.md', {})
    expect(res.headers.get('Content-Type')).not.toMatch(/json/)
    expect(remoteImagesGrantCount()).toBe(before)
  })

  it('security-4 [6] 合言葉は時間で切れ、持つ数に上限がある', () => {
    const now = 1_000_000
    const token = issueRemoteImagesGrant('a.md', now)
    expect(consumeRemoteImagesGrant(token, 'a.md', now + REMOTE_IMAGES_GRANT_TTL_MS + 1)).toBe(false)
    for (let i = 0; i < MAX_REMOTE_IMAGES_GRANTS * 3; i++) issueRemoteImagesGrant(`f${i}.md`, now)
    expect(remoteImagesGrantCount()).toBeLessThanOrEqual(MAX_REMOTE_IMAGES_GRANTS)
  })

  it('security-4 [6] プロジェクトの状態には許可の印を保存も復元もしない', () => {
    const url = 'ade-preview://project/README.md?remote-images=abc&x=1#top'
    expect(stripPreviewGrant(url)).toBe('ade-preview://project/README.md?x=1#top')
    expect(stripPreviewGrant('https://example.com/?remote-images=1')).toBe('https://example.com/?remote-images=1')
    expect(sanitizeProjectSession({ url: 'ade-preview://project/README.md?remote-images=1' })?.url).toBe('ade-preview://project/README.md')
    const projects = withProjectSession([{ id: 'p', name: 'acme-shop', folderPath: '/x', urls: [] } as never], 'p', { url })
    expect(JSON.stringify(projects)).not.toContain('remote-images')
  })
})
