import { afterEach, describe, expect, it, vi } from 'vitest'
import { setReporter, type Reporter } from '../../src/shared/report'

vi.mock('electron', () => ({ app: { getVersion: () => '44.5.1' }, net: { fetch: vi.fn() } }))
const { checkForUpdate } = await import('../../src/main/updateCheck')
const { version } = await import('../../package.json')

/**
 * 更新の確認（checkForUpdate）の結果と、確認できなかったときに Sentry へ warning（area: update）で知らせること。
 * 配信元へは取りに行かない（fetch を差し替える）。
 */

const manifest = (v: string) => ({ schema: 1, version: v, date: '', prerelease: false, notes: '', files: [] })
const respond = (status: number, body: unknown) =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch

function captured() {
  const handled = vi.fn<Reporter['handled']>()
  setReporter({ handled, message: vi.fn(), breadcrumb: vi.fn() })
  return handled
}

afterEach(() => setReporter(null))

describe('checkForUpdate', () => {
  it('配信元の版が今と同じなら最新（dev 起動も package.json の版で比べる）', async () => {
    const handled = captured()
    const r = await checkForUpdate(respond(200, manifest(version)))
    expect(r).toEqual({ state: 'latest', current: version, latest: version })
    expect(handled).not.toHaveBeenCalled()
  })
  it('まだ latest.json が無い（404）のは失敗にしない・送らない', async () => {
    const handled = captured()
    expect((await checkForUpdate(respond(404, 'not found'))).state).toBe('no-release')
    expect(handled).not.toHaveBeenCalled()
  })
  it('ネットワークの失敗は、静かな「確認できなかった」にして area: update で送る', async () => {
    const handled = captured()
    const fail = (async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED') }) as unknown as typeof fetch
    const r = await checkForUpdate(fail)
    expect(r.state).toBe('error')
    expect(handled).toHaveBeenCalledWith(expect.objectContaining({ message: 'net::ERR_INTERNET_DISCONNECTED' }),
      { kind: 'handled', area: 'update', op: 'check update: network' }, 'warning')
  })
  it('時間切れは timeout として送る', async () => {
    const handled = captured()
    const slow = (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }) as unknown as typeof fetch
    expect((await checkForUpdate(slow)).state).toBe('error')
    expect(handled.mock.calls[0]![1].op).toBe('check update: timeout')
  })
  it('壊れた latest.json・HTTP の失敗・読めない版も送る', async () => {
    const handled = captured()
    expect((await checkForUpdate(respond(200, '{broken'))).state).toBe('error')
    expect((await checkForUpdate(respond(500, 'oops'))).state).toBe('error')
    expect((await checkForUpdate(respond(200, manifest('not-a-version')))).state).toBe('error')
    expect(handled.mock.calls.map((c) => c[1].op)).toEqual(['check update: bad-manifest', 'check update: http', 'check update: bad-version'])
  })
})
