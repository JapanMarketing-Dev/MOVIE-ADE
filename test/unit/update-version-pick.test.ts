/**
 * バージョンを選んで入れる（0.6.8）：配信元の版の一覧（versions.json）・選んだ版の確認（releases/<版>/manifest.json）・
 * AutoUpdater の固定（古い版を選んだら自動の更新を止め、定期の確認で最新へ戻さない）。配信元へは行かない
 */
import { describe, expect, it, vi } from 'vitest'
import type { UpdateCheckResult } from '../../src/shared/appVersion'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1' }, net: { fetch: vi.fn() } }))
const { parseVersionsIndex, listReleaseVersions, checkForVersion } = await import('../../src/main/updateCheck')
const { AutoUpdater } = await import('../../src/main/autoUpdate')
const { version: current } = await import('../../package.json')
type AutoUpdateDeps = ConstructorParameters<typeof AutoUpdater>[0]

const respond = (status: number, body: unknown) =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch

describe('配信元の版の一覧', () => {
  it('新しい順・重複と形の違う行は捨てる・v は外す・20 件まで', () => {
    const list = parseVersionsIndex({ versions: [
      { version: '0.6.2', date: '2026-10-01T00:00:00Z' },
      { version: 'v0.6.7', date: 'not a date', prerelease: true },
      { version: '0.6.2' },
      { version: 'nope' },
      null,
      { version: '0.6.10' }
    ] })
    expect(list).toEqual([
      { version: '0.6.10', date: '', prerelease: false },
      { version: '0.6.7', date: '', prerelease: true },
      { version: '0.6.2', date: '2026-10-01T00:00:00Z', prerelease: false }
    ])
    expect(parseVersionsIndex({ versions: Array.from({ length: 30 }, (_, i) => ({ version: `1.0.${i}` })) })).toHaveLength(20)
    expect(parseVersionsIndex(null)).toEqual([])
    expect(parseVersionsIndex({ versions: 'x' })).toEqual([])
  })

  it('取れない・壊れているときは空（一覧を出さないだけ）', async () => {
    expect(await listReleaseVersions(respond(404, 'no'))).toEqual([])
    expect(await listReleaseVersions(respond(200, '{broken'))).toEqual([])
    expect(await listReleaseVersions((async () => { throw new Error('offline') }) as unknown as typeof fetch)).toEqual([])
    expect((await listReleaseVersions(respond(200, { versions: [{ version: '0.6.5' }] }))).map((v) => v.version)).toEqual(['0.6.5'])
  })
})

describe('選んだ版を確かめる', () => {
  it('今と同じ版は latest、読めない版は error。その版の manifest を読み、版が違えば断る', async () => {
    expect(await checkForVersion(current, respond(500, ''))).toEqual({ state: 'latest', current, latest: current })
    expect((await checkForVersion('../../x', respond(200, {}))).state).toBe('error')
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ schema: 1, version: '0.5.0', date: '', prerelease: false, notes: '', files: [] }), { status: 200 })
    }) as unknown as typeof fetch
    expect((await checkForVersion('0.4.0', fetcher)).state).toBe('error')
    expect(urls[0]).toMatch(/\/releases\/0\.4\.0\/manifest\.json$/)
    expect((await checkForVersion('0.4.0', respond(404, 'no'))).state).toBe('error')
  })
})

describe('AutoUpdater.chooseVersion', () => {
  const fileOf = (v: string) => ({ version: v, name: `Ferret-${v}-mac-arm64.zip`, sha256: 'a'.repeat(64), size: 100, kind: 'zip' as const, url: `https://example.invalid/${v}.zip` })
  const latest: UpdateCheckResult = { state: 'available', current: '1.0.0', latest: '2.0.0', url: 'https://ferretade.dev/download' }

  function setup() {
    let auto = true
    let chosen = '2.0.0'
    const calls: string[] = []
    const deps: AutoUpdateDeps = {
      method: 'squirrel-mac',
      enabled: true,
      canInstall: true,
      check: async () => { chosen = '2.0.0'; return latest },
      checkVersion: async (v) => {
        if (v === '9.9.9') return { state: 'error', current: '1.0.0', message: 'missing' }
        chosen = v
        return { state: 'available', current: '1.0.0', latest: v, url: 'https://ferretade.dev/download' }
      },
      verifiedFile: () => fileOf(chosen),
      download: async (f) => { calls.push(`download ${f.version}`); return `/cache/${f.name}` },
      hashFile: async () => null,
      prepareDir: async (keep) => ({ dir: '/cache', target: `/cache/${keep}` }),
      stage: async (_m, path) => { calls.push(`stage ${path}`) },
      install: async () => undefined,
      installOnQuit: () => true,
      getAutoDownload: () => auto,
      setAutoDownload: (on) => { auto = on },
      emit: () => undefined,
      report: vi.fn(),
      failedMessage: () => 'failed'
    }
    return { updater: new AutoUpdater(deps), calls, auto: () => auto }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('古い版を選ぶと、その版を落として準備し、自動の更新を止める。定期の確認でも最新へ戻さない。自動をオンに戻すと外れる', async () => {
    const { updater, calls, auto } = setup()
    const status = await updater.chooseVersion('1.5.0', '2.0.0')
    expect(calls).toContain('download 1.5.0')
    expect(status.progress).toMatchObject({ phase: 'ready', version: '1.5.0' })
    expect(updater.pinnedVersion()).toBe('1.5.0')
    expect(auto()).toBe(false)

    await updater.checkNow()
    await settle()
    expect(updater.status().progress).toMatchObject({ version: '1.5.0' })
    expect(calls).not.toContain('download 2.0.0')

    updater.setAutoDownload(true)
    expect(updater.pinnedVersion()).toBeNull()
    await settle()
    await settle()
    expect(calls).toContain('download 2.0.0')
  })

  it('最新の版を選んだら固定しない。無い版は固定せず、自動の更新もそのまま', async () => {
    const { updater, auto } = setup()
    await updater.chooseVersion('2.0.0', '2.0.0')
    expect(updater.pinnedVersion()).toBeNull()
    expect(auto()).toBe(true)
    const missing = await updater.chooseVersion('9.9.9', '2.0.0')
    expect(missing.check?.state).toBe('error')
    expect(updater.pinnedVersion()).toBeNull()
    expect(auto()).toBe(true)
  })
})
