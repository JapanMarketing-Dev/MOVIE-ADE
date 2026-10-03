import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * クラッシュレポートの経路のうち、renderer の ErrorBoundary からの送信と、dev のスタックの戻し方。
 * Sentry へは送らない（captureException を差し替える）。
 */

const captureException = vi.fn()
vi.mock('@sentry/electron/renderer', () => ({ captureException, addBreadcrumb: vi.fn(), init: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

// renderer のファイルは型検査（tsconfig.test.json）の外なので、実行時だけ読む
const rendererModule = (path: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ path)

/**
 * 1行目に1行足しただけの「ビルド後」とソースマップを作る（生成の2行目以降 → 元の1行目以降）。
 * ;AAAA;AACA;… は「生成の n+1 行目の先頭 = 元の n 行目の先頭」を並べたもの。
 */
function buildWithMap(source: string, sourceName: string): { code: string; map: string } {
  const lines = source.split('\n')
  const mappings = ';' + lines.map((_, i) => (i === 0 ? 'AAAA' : 'AACA')).join(';')
  return {
    code: ['"use strict";', ...lines].join('\n'),
    map: JSON.stringify({ version: 3, sources: [sourceName], sourcesContent: [source], names: [], mappings })
  }
}

describe('ErrorBoundary からの送信', () => {
  it('componentDidCatch が境界の名前と componentStack を付けて送る（初期化した起動だけ）', async () => {
    ;(globalThis as { window?: unknown }).window = {
      ade: { invoke: vi.fn(async () => ({ active: true, enabled: true, noticeShown: true, packaged: false, test: [] })) },
      setTimeout
    }
    const telemetry = await rendererModule('../../src/renderer/lib/telemetry')
    const { ErrorBoundary } = await rendererModule('../../src/renderer/ui/ErrorBoundary') as {
      ErrorBoundary: new (props: { name: string; children: null }) => { componentDidCatch: (e: Error, info: { componentStack: string }) => void }
    }
    const error = new Error('render failed')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // 初期化していないうちは送らない
    new ErrorBoundary({ name: 'terminal', children: null }).componentDidCatch(error, { componentStack: '\n    at Bomb' })
    expect(captureException).not.toHaveBeenCalled()

    await (telemetry.initRendererCrashReporting as () => Promise<void>)()
    new ErrorBoundary({ name: 'terminal', children: null }).componentDidCatch(error, { componentStack: '\n    at Bomb' })
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { kind: 'render-error', 'error.boundary': 'terminal' },
      contexts: { react: { componentStack: 'at Bomb' } }
    })
    quiet.mockRestore()
  })
})

describe('dev のスタックを元のファイルと行へ戻す', () => {
  it('out/ の .map を読んで app:///src/... の行と前後の行にする', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ade-remap-'))
    const source = ['export function run(): void {', '  const x: number = 1', "  throw new Error('boom ' + x)", '}', ''].join('\n')
    const out = buildWithMap(source, '../../src/main/a.ts')
    mkdirSync(join(root, 'out', 'main'), { recursive: true })
    writeFileSync(join(root, 'out', 'main', 'a.js'), out.code)
    writeFileSync(join(root, 'out', 'main', 'a.js.map'), out.map)
    const lines = out.code.split('\n')
    const line = lines.findIndex((l) => l.includes('throw'))
    const frame = { filename: 'app:///out/main/a.js', lineno: line + 1, colno: 1 }

    const { remapDevFrames } = await import('../../src/main/telemetrySourceMaps')
    const event = { exception: { values: [{ stacktrace: { frames: [frame] } }] } }
    await remapDevFrames(event, { appPath: root })
    const f = event.exception.values[0]!.stacktrace.frames[0]! as typeof frame & { context_line?: string; pre_context?: string[] }
    expect(f.filename).toBe('app:///src/main/a.ts')
    expect(f.lineno).toBe(3)
    expect(f.context_line).toBe("  throw new Error('boom ' + x)")
    expect(f.pre_context).toEqual(['export function run(): void {', '  const x: number = 1'])
  })

  it('renderer は dev サーバーのモジュールの inline のソースマップを読む', async () => {
    const source = ['const a = 1', "throw new Error('r' + a)", ''].join('\n')
    // Vite はモジュールのフォルダからの相対で sources を書く
    const built = buildWithMap(source, 'b.ts')
    const out = { code: `${built.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(built.map).toString('base64')}` }
    const lines = out.code.split('\n')
    const line = lines.findIndex((l) => l.includes('throw'))
    const { remapDevFrames } = await import('../../src/main/telemetrySourceMaps')
    const event = { exception: { values: [{ stacktrace: { frames: [{ filename: 'http://localhost:5173/lib/b.ts?t=1', lineno: line + 1, colno: 1 }] } }] } }
    await remapDevFrames(event, { appPath: '/repo', rendererUrl: 'http://localhost:5173/', fetchText: async () => out.code })
    const f = event.exception.values[0]!.stacktrace.frames[0]!
    expect(f.filename).toBe('app:///src/renderer/lib/b.ts')
    expect(f.lineno).toBe(2)
  })

  it('読めないフレームはそのまま残す', async () => {
    const { remapDevFrames } = await import('../../src/main/telemetrySourceMaps')
    const frame = { filename: 'app:///out/main/missing.js', lineno: 5, colno: 1 }
    const event = { exception: { values: [{ stacktrace: { frames: [frame] } }] } }
    await remapDevFrames(event, { appPath: '/nonexistent' })
    expect(event.exception.values[0]!.stacktrace.frames[0]).toEqual({ filename: 'app:///out/main/missing.js', lineno: 5, colno: 1 })
  })
})

describe('dev の renderer の @fs のモジュール', () => {
  it('SDK がアプリの場所を縮めた「/@fsapp:///…」も、元の URL で取りに行って戻す', async () => {
    const source = ['export const x = 1', "throw new Error('fs')", ''].join('\n')
    const built = buildWithMap(source, 'reviewTarget.ts')
    const code = `${built.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(built.map).toString('base64')}`
    const fetched: string[] = []
    const { remapDevFrames } = await import('../../src/main/telemetrySourceMaps')
    const event = { exception: { values: [{ stacktrace: { frames: [{ filename: 'http://localhost:5173/@fsapp:///src/shared/reviewTarget.ts?t=2', lineno: 3, colno: 1 }] } }] } }
    await remapDevFrames(event, { appPath: '/repo', rendererUrl: 'http://localhost:5173/', fetchText: async (u) => { fetched.push(u); return code } })
    expect(fetched).toEqual(['http://localhost:5173/@fs/repo/src/shared/reviewTarget.ts?t=2'])
    expect(event.exception.values[0]!.stacktrace.frames[0]).toMatchObject({ filename: 'app:///src/shared/reviewTarget.ts', lineno: 2 })
  })
})
