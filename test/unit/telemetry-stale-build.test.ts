import { describe, expect, it, vi } from 'vitest'
import { isStaleChunkError, isUserFacingError, toUserFacingFileError } from '../../src/shared/errors'
import { classifyStaleBuild, wrapIpcHandler } from '../../src/shared/telemetry'
import { t } from '../../src/shared/i18n'

/**
 * 起動中に out/ が入れ替わり、遅延 import の分割ファイルが無くなった失敗（Sentry FERRET-X）。
 * capture:sources の `await import('./recording/sources')` が `Cannot find module './chunks/sources-〜.js'` で落ちた
 */
const cjsError = () => Object.assign(new Error("Cannot find module './chunks/sources-BPhJAXgd.js'\nRequire stack:\n- /app/out/main/index.js"), { code: 'MODULE_NOT_FOUND' })
const esmError = () => Object.assign(new Error("Cannot find module '/app/out/main/chunks/sources-B_CYgxdQ.mjs' imported from /app/out/main/index.mjs"), { code: 'ERR_MODULE_NOT_FOUND' })
const winError = () => Object.assign(new Error("Cannot find module '.\\chunks\\sources-BPhJAXgd.js'"), { code: 'MODULE_NOT_FOUND' })

describe('isStaleChunkError', () => {
  it('分割ファイル（chunks/〜.js）が無い失敗を見分ける（CJS・ESM・Windows の区切り）', () => {
    expect(isStaleChunkError(cjsError())).toBe(true)
    expect(isStaleChunkError(esmError())).toBe(true)
    expect(isStaleChunkError(winError())).toBe(true)
  })

  it('依存パッケージが無い・コードの無い同じ文は対象外（本物の不具合として送る）', () => {
    expect(isStaleChunkError(Object.assign(new Error("Cannot find module 'node-pty'"), { code: 'MODULE_NOT_FOUND' }))).toBe(false)
    expect(isStaleChunkError(new Error("Cannot find module './chunks/sources-BPhJAXgd.js'"))).toBe(false)
    expect(isStaleChunkError(null)).toBe(false)
    expect(isStaleChunkError('Cannot find module')).toBe(false)
  })
})

describe('toUserFacingFileError（分割ファイルが無い）', () => {
  it('「アプリのファイルが入れ替わりました」の UserFacingError にし、元のエラーを cause に残す', () => {
    const err = cjsError()
    const wrapped = toUserFacingFileError(err) as Error
    expect(isUserFacingError(wrapped)).toBe(true)
    expect(wrapped.message).toBe(t('errors.appFilesReplaced'))
    expect(wrapped.cause).toBe(err)
  })

  it('IPC の失敗としては送らない（落とさずに利用者へ知らせる）', async () => {
    const report = vi.fn()
    const run = wrapIpcHandler('capture:sources', async () => {
      try { throw cjsError() } catch (e) { throw toUserFacingFileError(e) }
    }, report)
    await expect(run()).rejects.toThrow(t('errors.appFilesReplaced'))
    expect(report).not.toHaveBeenCalled()
  })
})

type SentryEventLike = { exception?: unknown; tags?: Record<string, unknown>; fingerprint?: string[]; message?: string }

describe('classifyStaleBuild', () => {
  const event = (): SentryEventLike => ({ exception: { values: [{ type: 'Error', value: "Cannot find module './chunks/sources-BPhJAXgd.js'" }] }, tags: { kind: 'ipc', 'ipc.channel': 'capture:sources' } })

  it('dev（out/ の build し直し）は送らない', () => {
    expect(classifyStaleBuild(event(), false)).toBeNull()
  })

  it('配布版は kind: stale-build を付け、1件にまとめる', () => {
    const out = classifyStaleBuild(event(), true)
    expect(out?.tags).toEqual({ kind: 'stale-build', 'ipc.channel': 'capture:sources' })
    expect(out?.fingerprint).toEqual(['stale-build'])
  })

  it('ほかの失敗はそのまま', () => {
    const other = { exception: { values: [{ value: "Cannot find module 'node-pty'" }] }, tags: { kind: 'ipc' } }
    expect(classifyStaleBuild(other, false)).toBe(other)
    const anomaly: SentryEventLike = { message: 'Slow startup (7.4s)' }
    expect(classifyStaleBuild(anomaly, true)).toBe(anomaly)
  })
})
