import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainFetch } from '../../src/main/netFetch'
import { checkLocalServer } from '../../src/main/localModels'

afterEach(() => vi.unstubAllGlobals())

describe('main からの外向き HTTP（Orca #22456 #1378 #8695）', () => {
  it('Electron の外（単体テスト）では Node の fetch をそのまま使う', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const res = await mainFetch('https://api.example.test/v1/x', { method: 'POST', body: 'a' })
    expect(await res.text()).toBe('ok')
    // キーを送る依頼なので、リダイレクトは既定で追わない（security-7 [10]）
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/v1/x', { method: 'POST', body: 'a', redirect: 'error' })
  })

  it('ローカルのサーバーが失敗を返したら、読まない本文を捨ててから down を返す', async () => {
    const cancel = vi.fn(async () => undefined)
    const res = { ok: false, body: { cancel } } as unknown as Response
    expect(await checkLocalServer('http://127.0.0.1:11434/v1', 'm', async () => res)).toBe('down')
    expect(cancel).toHaveBeenCalledOnce()
  })
})
