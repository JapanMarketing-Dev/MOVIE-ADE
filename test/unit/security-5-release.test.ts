import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashLocalArtifacts, signedSumsFromLocal } from '../../scripts/release-local-sums.mjs'
import { parseSha256Sums } from '../../scripts/release-r2-lib.mjs'
import type { Env, LimiterStorage } from '../../workers/feedback-relay/src/env'
import { handle } from '../../workers/feedback-relay/src/index'
import { FeedbackLimiter } from '../../workers/feedback-relay/src/limiter'
import { ATTEMPT_LIMITS, PREPARSE_LIMITS } from '../../workers/feedback-relay/src/limits'
import { METADATA_MAX_BYTES, fetchBounded, fetchBoundedJson, readBounded, verifyRelease } from '../../site/js/verify.js'

/**
 * Codex のセキュリティスキャン5回目のうち、配布・公開の中継・ダウンロードページ・Linux のビルドの件（[8][10][12][13]）。
 * 同じ穴が戻ったら落ちる形で書く（ふるまいのテストと、ソースの形の不変条件）。
 */

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

// ───────────────────────── [8] 署名は手元のハッシュに ─────────────────────────

describe('security-5 [8] the release signer hashes local installers instead of signing R2 digests', () => {
  const V = '9.8.7'
  const DMG = `Ferret-${V}-mac-arm64.dmg`
  const EXE = `Ferret-${V}-win-x64.exe`
  const ZIP = `Ferret-${V}-mac-arm64.zip`
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sec5-release-'))
    writeFileSync(join(dir, DMG), 'dmg-bytes')
    writeFileSync(join(dir, EXE), 'exe-bytes')
    writeFileSync(join(dir, ZIP), 'zip-bytes')
    // 配布物でないもの（数えない）
    writeFileSync(join(dir, `${DMG}.blockmap`), 'x')
    writeFileSync(join(dir, 'BUILD-PROVENANCE.txt'), 'x')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const manifestOf = (files: Array<{ name: string; size: number; sha256: string }>, updates?: Array<{ name: string; size: number; sha256: string }>) => ({ files, ...(updates ? { updates } : {}) })

  it('hashes the installers and update files in the folder itself', async () => {
    const local = await hashLocalArtifacts(dir, V)
    expect(local.files).toEqual([
      { name: DMG, size: 9, sha256: sha('dmg-bytes') },
      { name: EXE, size: 9, sha256: sha('exe-bytes') }
    ])
    expect(local.updates).toEqual([{ name: ZIP, size: 9, sha256: sha('zip-bytes') }])
  })

  it('signs only the local hashes; a matching manifest changes nothing', async () => {
    const local = await hashLocalArtifacts(dir, V)
    const out = signedSumsFromLocal(local, manifestOf(local.files, local.updates))
    expect(parseSha256Sums(out.sums)).toEqual(new Map([[DMG, sha('dmg-bytes')], [EXE, sha('exe-bytes')]]))
    expect(parseSha256Sums(out.updateSums!)).toEqual(new Map([[ZIP, sha('zip-bytes')]]))
  })

  it('an R2 manifest with a replaced digest, size, extra or missing file cannot change what is signed (it stops)', async () => {
    const local = await hashLocalArtifacts(dir, V)
    const evil = sha('attacker')
    const replaced = local.files.map((f) => (f.name === DMG ? { ...f, sha256: evil } : f))
    expect(() => signedSumsFromLocal(local, manifestOf(replaced, local.updates))).toThrow(/sha256/)
    const resized = local.files.map((f) => (f.name === DMG ? { ...f, size: f.size + 1 } : f))
    expect(() => signedSumsFromLocal(local, manifestOf(resized, local.updates))).toThrow(/sha256/)
    const extra = [...local.files, { name: `Ferret-${V}-linux-x86_64.AppImage`, size: 1, sha256: evil }]
    expect(() => signedSumsFromLocal(local, manifestOf(extra, local.updates))).toThrow(/手元にありません/)
    expect(() => signedSumsFromLocal(local, manifestOf(local.files.slice(1), local.updates))).toThrow(/manifest にありません/)
    // 自動更新のファイル（UPDATE-SHA256SUMS）も同じ
    expect(() => signedSumsFromLocal(local, manifestOf(local.files, [{ name: ZIP, size: 9, sha256: evil }]))).toThrow(/sha256/)
    expect(() => signedSumsFromLocal(local, manifestOf(local.files))).toThrow(/manifest にありません/)
  })

  it('requires local installers and refuses symbolic links', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sec5-release-empty-'))
    try {
      await expect(hashLocalArtifacts(empty, V)).rejects.toThrow(/配布物がありません/)
      mkdirSync(join(empty, 'elsewhere'))
      writeFileSync(join(empty, 'elsewhere', 'x'), 'x')
      symlinkSync(join(empty, 'elsewhere', 'x'), join(empty, `Ferret-${V}-linux-amd64.deb`))
      await expect(hashLocalArtifacts(empty, V)).rejects.toThrow(/通常のファイルではありません/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('release-github.mjs create hashes the local folder before signing and never formats sums from the manifest', () => {
    const text = read('scripts/release-github.mjs')
    expect(text).not.toMatch(/formatSha256Sums\(\s*manifest/)
    expect(text).not.toMatch(/formatSha256Sums/)
    const hashed = text.indexOf('await hashLocalArtifacts(')
    const compared = text.indexOf('signedSumsFromLocal(local, manifest)')
    expect(hashed).toBeGreaterThan(0)
    expect(compared).toBeGreaterThan(hashed)
    // 署名は比べたあと
    expect(text.indexOf('signSshsig(')).toBeGreaterThan(compared)
  })

  it('promotion still checks the signature and rehashes what R2 serves (the independently signed set)', () => {
    const r2 = read('scripts/release-r2.mjs')
    expect(r2).toMatch(/checkExpectedSums\(manifest, args, true\)/)
    expect(r2).toMatch(/assertSignedSums\(sums/)
    expect(r2).toMatch(/\(await sha256\(local\)\) !== f\.sha256/)
  })
})

// ───────────────────────── [10] 全体の枠を先に予約 ─────────────────────────

class MemoryStorage implements LimiterStorage {
  data = new Map<string, unknown>()
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, value)
  }
  async deleteAll() {
    this.data.clear()
  }
  async setAlarm() {}
}

function fakeEnv() {
  const limiters = new Map<string, { storage: MemoryStorage; obj: FeedbackLimiter }>()
  const queues = new Map<string, Promise<unknown>>()
  const env = {
    GITHUB_TOKEN: ['fake', 'token'].join('-'),
    RATE_LIMIT_SALT: 'test-salt',
    GITHUB_REPO: 'JapanMarketing-Dev/ferret',
    PUBLIC_BASE: 'https://feedback.example.test',
    MEDIA: { async put() {}, async get() { return null }, async delete() {} },
    LIMITER: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const name = id as string
        if (!limiters.has(name)) {
          const storage = new MemoryStorage()
          limiters.set(name, { storage, obj: new FeedbackLimiter({ storage } as never) })
        }
        // 本物の Durable Object と同じく、1つの鍵の要求は1つずつ処理する
        const entry = limiters.get(name)!
        return {
          fetch: (r: Request) => {
            const run = (queues.get(name) ?? Promise.resolve()).then(() => entry.obj.fetch(r))
            queues.set(name, run.catch(() => undefined))
            return run
          }
        }
      }
    }
  } as unknown as Env
  /** 記録（時刻）を持っている limiter の名前 */
  const stateful = (prefix: string) => [...limiters].filter(([n, e]) => n.startsWith(prefix) && ((e.storage.data.get('times') as number[] | undefined)?.length ?? 0) > 0).length
  const times = (name: string) => ((limiters.get(name)?.storage.data.get('times') as number[] | undefined) ?? []).length
  return { env, limiters, stateful, times }
}

const T0 = 1_800_000_000_000
const v6 = (i: number) => `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`
// 形の悪い送信（本文を読む前の枠だけを通り、415 で終わる）
const attemptFrom = (ip: string) =>
  new Request('https://feedback.example.test/v1/issues', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain', 'cf-connecting-ip': ip } })
const noGithub = { fetch: vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch, now: () => T0 }

describe('security-5 [10] the feedback relay reserves the global budget before any per-source state', () => {
  const max = Math.min(...PREPARSE_LIMITS.map((w) => w.max))
  const perSourceMax = Math.min(...ATTEMPT_LIMITS.map((w) => w.max))

  it('concurrent distinct sources cannot create per-source state beyond the global budget', async () => {
    const { env, limiters, stateful } = fakeEnv()
    const results = await Promise.all(Array.from({ length: max + 50 }, (_, i) => handle(attemptFrom(v6(i)), env, noGithub)))
    expect(results.filter((r) => r.status === 415)).toHaveLength(max)
    expect(results.filter((r) => r.status === 429)).toHaveLength(50)
    // 送り主ごとの limiter は、記録を持つものも、作られたものも、全体の枠の数まで
    expect(stateful('attempt:')).toBeLessThanOrEqual(max)
    expect([...limiters.keys()].filter((n) => n.startsWith('attempt:')).length).toBeLessThanOrEqual(max)
    expect([...limiters.keys()].filter((n) => n.startsWith('ip:')).length).toBeLessThanOrEqual(max)
  })

  it('a source refused by its own attempt quota releases the global reservation', async () => {
    const { env, times } = fakeEnv()
    const statuses: number[] = []
    for (let i = 0; i < perSourceMax + 5; i++) statuses.push((await handle(attemptFrom('203.0.113.9'), env, noGithub)).status)
    expect(statuses.filter((s) => s === 415)).toHaveLength(perSourceMax)
    expect(statuses.filter((s) => s === 429)).toHaveLength(5)
    expect(times('preparse')).toBe(perSourceMax)
  })

  it('sequential and concurrent requests get the same quotas', async () => {
    const seq = fakeEnv()
    const sequential: number[] = []
    for (let i = 0; i < perSourceMax + 10; i++) sequential.push((await handle(attemptFrom('203.0.113.10'), seq.env, noGithub)).status)
    const con = fakeEnv()
    const concurrent = (await Promise.all(Array.from({ length: perSourceMax + 10 }, () => handle(attemptFrom('203.0.113.10'), con.env, noGithub)))).map((r) => r.status)
    expect(concurrent.filter((s) => s === 415).length).toBe(sequential.filter((s) => s === 415).length)
    expect(con.times('preparse')).toBe(seq.times('preparse'))
  })

  it('takes the shared pre-parse reservation (hit, not peek) before the per-source attempt limiter', () => {
    const relay = read('workers/feedback-relay/src/index.ts')
    expect(relay).not.toMatch(/askLimiter\(env, 'preparse', 'peek'/)
    const reserve = relay.indexOf("askLimiter(env, 'preparse', 'hit'")
    expect(reserve).toBeGreaterThan(0)
    expect(reserve).toBeLessThan(relay.indexOf("'attempt'"))
    expect(relay).toMatch(/askLimiter\(env, 'preparse', 'release'/)
  })
})

// ───────────────────────── [12] サイトの小さなファイルは流しながら上限 ─────────────────────────

describe('security-5 [12] the download page reads release metadata with a streaming cap and a deadline', () => {
  /** 64 KiB ずつ際限なく返す本文。読まれた回数と、切られたかを数える */
  function endless(chunk = 64 * 1024) {
    const state = { pulled: 0, canceled: false }
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled++
        controller.enqueue(new Uint8Array(chunk).fill(0x20))
      },
      cancel() {
        state.canceled = true
      }
    })
    return { body, state }
  }
  /** 何も返さない本文（止まったまま） */
  function stalled() {
    const state = { canceled: false }
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined)
      },
      cancel() {
        state.canceled = true
      }
    })
    return { body, state }
  }

  it('cancels an oversized chunked JSON body once the cap is passed, without buffering it all', async () => {
    const { body, state } = endless()
    const fetcher = (async () => new Response(body)) as unknown as typeof fetch
    await expect(fetchBoundedJson('https://downloads.example.test/latest.json', fetcher)).rejects.toThrow(/too large/)
    expect(state.canceled).toBe(true)
    expect(state.pulled * 64 * 1024).toBeLessThanOrEqual(METADATA_MAX_BYTES + 3 * 64 * 1024)
  })

  it('refuses a declared Content-Length above the cap before reading', async () => {
    const { body, state } = endless()
    const res = new Response(body, { headers: { 'content-length': String(METADATA_MAX_BYTES + 1) } })
    await expect(readBounded(res, METADATA_MAX_BYTES)).rejects.toThrow(/too large/)
    expect(state.canceled).toBe(true)
  })

  it('times out an endless signature body and a server that never answers', async () => {
    const { body, state } = stalled()
    const slowBody = (async () => new Response(body)) as unknown as typeof fetch
    await expect(fetchBounded('https://downloads.example.test/x.sig', 64 * 1024, slowBody, 50)).rejects.toThrow(/timeout/)
    expect(state.canceled).toBe(true)
    const neverAnswers = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch
    await expect(fetchBounded('https://downloads.example.test/x.sig', 64 * 1024, neverAnswers, 50)).rejects.toThrow(/abort/i)
  })

  it('verifyRelease fails (no links) when SHA256SUMS(.sig) is endless or never finishes', async () => {
    const release = { version: '2.0.0', assets: [{ name: 'Ferret-2.0.0-mac-arm64.dmg', url: 'https://downloads.example.test/releases/2.0.0/Ferret-2.0.0-mac-arm64.dmg', size: 1, sha256: sha('x'), preview: false }] }
    const huge = (async () => new Response(endless().body)) as unknown as typeof fetch
    await expect(verifyRelease(release, 'https://downloads.example.test', huge, 1000)).rejects.toThrow(/too large/)
    const stuck = (async () => new Response(stalled().body)) as unknown as typeof fetch
    await expect(verifyRelease(release, 'https://downloads.example.test', stuck, 50)).rejects.toThrow(/timeout/)
  })

  it('normal small JSON still loads, and missing files are null', async () => {
    const ok = (async () => Response.json({ schema: 1, latest: '2.0.0' })) as unknown as typeof fetch
    expect(await fetchBoundedJson('https://downloads.example.test/versions.json', ok)).toEqual({ schema: 1, latest: '2.0.0' })
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect(await fetchBoundedJson('https://downloads.example.test/versions.json', missing)).toBeNull()
  })

  it('site code never materializes a release response with res.json() / arrayBuffer() / text()', () => {
    const code = (p: string) =>
      read(p)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
        .join('\n')
    for (const p of ['site/js/app.js', 'site/js/verify.js', 'site/js/releases.js']) {
      expect(code(p), p).not.toMatch(/\.(json|arrayBuffer|text|blob)\(\)/)
    }
    expect(read('site/js/app.js')).toMatch(/fetchBoundedJson\(url\)/)
  })
})

// ───────────────────────── [13] Linux のビルドの材料を固定 ─────────────────────────

describe('security-5 [13] the local Linux release build runs only pinned inputs', () => {
  const script = read('scripts/build-release.sh')
  const value = (name: string) => new RegExp(`^${name}="([^"]+)"$`, 'm').exec(script)?.[1]

  it('the container image is pinned by digest and a tag-only image is refused by the script', () => {
    const image = value('LINUX_IMAGE')
    expect(image).toMatch(/@sha256:[0-9a-f]{64}$/)
    // run は固定した変数だけを使い、タグだけの参照（node:22-bookworm で終わる）を書かない
    expect(script).toMatch(/"\$\{LINUX_IMAGE\}" bash \/s\/run\.sh/)
    expect(script).not.toMatch(/node:22-bookworm\s+bash/)
    expect(script).not.toMatch(/docker\.io\/library\/node:[\w.-]+(?!@sha256)\s/)
    // 形の確かめ（digest でなければ止まる）と、取ったイメージの digest の確かめ
    expect(script).toMatch(/\[\[ ! "\$\{LINUX_IMAGE\}" =~ @sha256:\[0-9a-f\]\{64\}\$ \]\]/)
    expect(script).toMatch(/image inspect --format '\{\{range \.RepoDigests\}\}/)
    expect(script).toMatch(/--pull=never/)
  })

  it('apt reads only a fixed snapshot.debian.org date, and pnpm is pinned by sha512', () => {
    expect(value('DEBIAN_SNAPSHOT')).toMatch(/^\d{8}T\d{6}Z$/)
    expect(value('PNPM_SPEC')).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/)
    expect(script).toMatch(/rm -f \/etc\/apt\/sources\.list\.d\/\*/)
    const sources = [...script.matchAll(/^deb (\S+) /gm)].map((m) => m[1])
    expect(sources.length).toBeGreaterThan(0)
    for (const s of sources) expect(s).toMatch(/^https:\/\/snapshot\.debian\.org\/archive\/debian(-security)?\/\$\{DEBIAN_SNAPSHOT\}$/)
    expect(script).not.toMatch(/deb\.debian\.org/)
    expect(script).toMatch(/corepack prepare "\$\{PNPM_SPEC\}"/)
    expect(script).not.toMatch(/corepack prepare pnpm@/)
  })

  it('records build provenance (commit, inputs, each file sha256) next to the installers', () => {
    expect(script).toMatch(/BUILD-PROVENANCE\.txt/)
    expect(script).toMatch(/git -C "\$\{REPO\}" rev-parse HEAD/)
    expect(script).toMatch(/shasum -a 256 Ferret-/)
  })
})
