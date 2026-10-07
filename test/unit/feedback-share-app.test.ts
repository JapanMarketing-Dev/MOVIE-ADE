import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShareApiError, ShareClient } from '../../src/main/feedbackShare/client'
import { planImport } from '../../src/main/feedbackShare/importNotes'
import { MAX_SHARES_PER_PROJECT, ShareStore, sanitizeStoredShares, type StoredShare } from '../../src/main/feedbackShare/store'
import type { ShareComment, SharePage } from '../../src/shared/feedbackShare'

/**
 * 共有リンクのアプリ側（src/main/feedbackShare）。Worker は偽の fetch、保存は一時フォルダで確かめる。外へは送らない。
 */

const BASE = 'https://share.ferretade.dev'
const ID = 'a'.repeat(32)
// 本物に見える値をリポジトリに置かないよう、実行時に組み立てる
const TOKEN = ['0123456789abcdef'].join('').repeat(4)

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit; auth: string | null }> = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init, auth: new Headers(init.headers).get('authorization') })
    return respond(url, init)
  }
  return { fetch, calls }
}

describe('Worker との話し方（client.ts）', () => {
  it('トークンは Authorization だけで送り、URL に載せない', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true, share: { id: ID, pages: [], comments: [] } }))
    const client = new ShareClient({ fetch, base: BASE })
    await client.snapshot(ID, TOKEN)
    expect(calls[0]!.url).toBe(`${BASE}/v1/shares/${ID}`)
    expect(calls[0]!.url).not.toContain(TOKEN)
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('作った共有の応答の形を確かめ、ほかの場所のリンクは受けない', async () => {
    const good = { ok: true, id: ID, ownerToken: TOKEN, url: `${BASE}/s/${ID}`, expiresAt: '2026-11-06T00:00:00.000Z' }
    expect(await new ShareClient({ fetch: fakeFetch(() => Response.json(good, { status: 201 })).fetch, base: BASE }).create({ title: 't', showOthers: false }))
      .toEqual({ id: ID, ownerToken: TOKEN, url: good.url, expiresAt: good.expiresAt })
    const evil = new ShareClient({ fetch: fakeFetch(() => Response.json({ ...good, url: 'https://evil.example/s/x' }, { status: 201 })).fetch, base: BASE })
    await expect(evil.create({ title: 't', showOthers: false })).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('失敗は code だけにし、通信の失敗は network にする', async () => {
    const limited = new ShareClient({ fetch: fakeFetch(() => Response.json({ ok: false, code: 'rate_limited' }, { status: 429 })).fetch, base: BASE })
    await expect(limited.snapshot(ID, TOKEN)).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    const offline = new ShareClient({ fetch: async () => { throw new TypeError('fetch failed') }, base: BASE })
    await expect(offline.snapshot(ID, TOKEN)).rejects.toBeInstanceOf(ShareApiError)
    await expect(offline.snapshot(ID, TOKEN)).rejects.toMatchObject({ code: 'network' })
    // 形の違う ID・トークンは送らない
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true }))
    await expect(new ShareClient({ fetch, base: BASE }).snapshot('../x', TOKEN)).rejects.toMatchObject({ code: 'not_found' })
    await expect(new ShareClient({ fetch, base: BASE }).snapshot(ID, 'nope')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(calls).toEqual([])
  })

  it('ページの静止画は画像の応答だけ受け取る', async () => {
    const page = { id: '1'.repeat(16), ext: 'png' as const }
    const ok = new ShareClient({ fetch: fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })).fetch, base: BASE })
    expect(await ok.pageImage(ID, page)).toEqual(new Uint8Array([1, 2, 3]))
    const html = new ShareClient({ fetch: fakeFetch(() => new Response('<html>', { headers: { 'content-type': 'text/html' } })).fetch, base: BASE })
    expect(await html.pageImage(ID, page)).toBeNull()
  })
})

describe('共有の控え（store.ts）', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
  const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`), decrypt: (data: Buffer) => Buffer.from(data.toString().slice(4), 'base64').toString() }
  const share = (n: number, projectId = 'p1'): StoredShare => ({
    id: n.toString(16).padStart(32, '0'), projectId, title: `s${n}`, url: `${BASE}/s/${n}`, createdAt: new Date(Date.UTC(2026, 9, 7, 0, n)).toISOString(), expiresAt: '2099-01-01T00:00:00.000Z', ownerToken: TOKEN
  })

  it('トークンは暗号化して置き、画面へ返す一覧には入れない。プロジェクトごとに分ける', async () => {
    dir = await mkdtemp(join(tmpdir(), 'share-store-'))
    const path = join(dir, 'shares.bin')
    const store = new ShareStore(path, cipher)
    await store.add(share(1))
    await store.add(share(2, 'p2'))
    expect(await readFile(path, 'utf8')).not.toContain(TOKEN)
    const list = await store.list('p1')
    expect(list.map((s) => s.title)).toEqual(['s1'])
    expect(JSON.stringify(list)).not.toContain(TOKEN)
    expect(await store.get('p2', share(1).id)).toBeNull()
    // 読み直しても同じ
    expect((await new ShareStore(path, cipher).get('p1', share(1).id))?.ownerToken).toBe(TOKEN)
  })

  it('暗号化できない環境ではファイルに書かない。期限切れは忘れ、数に上限がある', async () => {
    dir = await mkdtemp(join(tmpdir(), 'share-store-'))
    const path = join(dir, 'shares.bin')
    const plain = new ShareStore(path, { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    await plain.add(share(1))
    expect(await plain.list('p1')).toHaveLength(1)
    await expect(readFile(path)).rejects.toThrow()

    const store = new ShareStore(join(dir, 'b.bin'), cipher, () => Date.parse('2026-10-07T00:00:00Z'))
    for (let i = 1; i <= MAX_SHARES_PER_PROJECT + 3; i++) await store.add(share(i))
    const list = await store.list('p1')
    expect(list).toHaveLength(MAX_SHARES_PER_PROJECT)
    expect(list.at(-1)!.title).toBe('s4')
    expect(sanitizeStoredShares({ shares: [{ ...share(1), ownerToken: 'short' }, { ...share(2), id: '../x' }] })).toEqual([])
  })
})

describe('届いた指摘を文字で指摘の形にする（importNotes.ts）', () => {
  const page: SharePage = { id: '1'.repeat(16), url: 'https://acme.example/', title: 'Home', viewport: 'desktop', width: 1000, height: 800, ext: 'jpg' }
  const comment = (over: Partial<ShareComment>): ShareComment => ({ id: '2'.repeat(16), pageId: page.id, createdAt: '2026-10-07T00:00:00Z', text: 'Fix the header', status: 'new', ...over })

  it('選んだ未確認の指摘だけを、枠と名前付きの文にする', () => {
    const plan = planImport({ pages: [page], comments: [
      comment({ id: 'a'.repeat(16), name: 'Hanako', shape: { kind: 'rect', x: 0.1, y: 0.2, w: 0.5, h: 0.25 } }),
      comment({ id: 'b'.repeat(16), status: 'rejected' }),
      comment({ id: 'c'.repeat(16), status: 'imported' }),
      comment({ id: 'd'.repeat(16), pageId: '9'.repeat(16) }),
      comment({ id: 'e'.repeat(16) })
    ] }, ['a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16), 'd'.repeat(16)])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.note).toEqual({ text: 'Hanako: Fix the header', bbox: [100, 160, 500, 200], view: { width: 1000, height: 800 } })
    expect(plan[0]!.notePage).toEqual({ url: page.url, title: 'Home' })
  })

  it('ライブで打った指摘は、静止画全体の枠と見ていた URL にする', () => {
    const [item] = planImport({ pages: [page], comments: [comment({ shape: { kind: 'pin', x: 0.5, y: 0.5 }, live: { url: 'https://acme.example/cart' } })] }, ['2'.repeat(16)])
    expect(item!.note.bbox).toEqual([0, 0, 1000, 800])
    expect(item!.note.text).toBe('Fix the header\n(https://acme.example/cart)')
    expect(item!.notePage.url).toBe('https://acme.example/cart')
  })
})
