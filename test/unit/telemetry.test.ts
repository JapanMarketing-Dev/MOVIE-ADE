import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SENTRY_DSN,
  MAX_EVENTS_PER_RUN,
  createEventLimiter,
  crashReportsEnabled,
  resolveSentryDsn,
  sampleEvent,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  sentryRelease,
  shouldSendCrashReports
} from '../../src/shared/telemetry'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

/**
 * クラッシュレポート（Sentry）の送る条件と、送る前の個人情報の除去。
 * 実際の送信はしない（beforeSend に渡る前後のイベントの形だけを見る）。
 */

describe('DSN', () => {
  it('環境変数が無ければ既定の DSN', () => {
    expect(resolveSentryDsn({})).toBe(DEFAULT_SENTRY_DSN)
  })
  it('環境変数で上書きできる（フォークした人の Sentry）', () => {
    expect(resolveSentryDsn({ MOVIE_ADE_SENTRY_DSN: ' https://abc@example.ingest.sentry.io/1 ' })).toBe('https://abc@example.ingest.sentry.io/1')
  })
  it('空にすれば送らない', () => {
    expect(resolveSentryDsn({ MOVIE_ADE_SENTRY_DSN: '' })).toBeNull()
    expect(resolveSentryDsn({ MOVIE_ADE_SENTRY_DSN: '   ' })).toBeNull()
  })
  it('release は movie-ade@<version>', () => {
    expect(sentryRelease('0.2.0')).toBe('movie-ade@0.2.0')
  })
})

describe('送る条件', () => {
  const base = { packaged: true, forced: false, e2e: false, enabled: true, dsn: DEFAULT_SENTRY_DSN }
  it('配布版で設定 ON なら送る', () => {
    expect(shouldSendCrashReports(base)).toBe(true)
  })
  it('dev 起動では送らない', () => {
    expect(shouldSendCrashReports({ ...base, packaged: false })).toBe(false)
  })
  it('E2E では送らない（配布版・確認用の指定があっても）', () => {
    expect(shouldSendCrashReports({ ...base, e2e: true })).toBe(false)
    expect(shouldSendCrashReports({ ...base, packaged: false, forced: true, e2e: true })).toBe(false)
  })
  it('設定 OFF なら送らない', () => {
    expect(shouldSendCrashReports({ ...base, enabled: false })).toBe(false)
  })
  it('DSN が空なら送らない', () => {
    expect(shouldSendCrashReports({ ...base, dsn: null })).toBe(false)
  })
  it('確認用の指定（MOVIE_ADE_SENTRY_FORCE）なら dev 起動でも送る', () => {
    expect(shouldSendCrashReports({ ...base, packaged: false, forced: true })).toBe(true)
  })
  it('設定は未設定なら ON、明示の false だけ OFF', () => {
    expect(crashReportsEnabled({})).toBe(true)
    expect(crashReportsEnabled({ crashReports: true })).toBe(true)
    expect(crashReportsEnabled({ crashReports: false })).toBe(false)
  })
})

describe('文字列の除去', () => {
  const ctx = { homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/secret-app'] }
  it('ホームのパスを ~ にする（macOS・Linux・Windows）', () => {
    expect(scrubString('ENOENT: /Users/hanako/Library/x.json')).toBe('ENOENT: ~/Library/x.json')
    expect(scrubString('open /home/hanako/.config/a')).toBe('open ~/.config/a')
    expect(scrubString('C:\\Users\\Hanako\\AppData\\Roaming\\ade-movie')).toBe('~\\AppData\\Roaming\\ade-movie')
    expect(scrubString('file:///Users/hanako/x.js')).toBe('file://~/x.js')
  })
  it('プロジェクトのフォルダは <project> にする', () => {
    expect(scrubString("can't read /Users/taro/work/secret-app/src/a.ts", ctx)).toBe("can't read <project>/src/a.ts")
  })
  it('内蔵ブラウザの URL を送らない', () => {
    expect(scrubString('failed to load https://intra.example.com/admin?id=42 (net::ERR)')).toBe('failed to load <url> (net::ERR)')
    expect(scrubString('ws://localhost:3000/socket closed')).toBe('<url> closed')
  })
  it('app:// のスタックのファイル名は残す（ソースマップの照合に要る）', () => {
    expect(scrubString('app:///out/main/index.js')).toBe('app:///out/main/index.js')
  })
  it('メールアドレスを送らない', () => {
    expect(scrubString('user hanako.yamada+test@example.co.jp not found')).toBe('user <email> not found')
  })
  it('API キー・トークンを送らない', () => {
    expect(scrubString('401 for sk-proj-abcdefghijklmnop1234')).toBe('401 for <secret>')
    expect(scrubString('token ghp_ABCDEFGHIJ1234567890abcd')).toBe('token <secret>')
    expect(scrubString('Authorization: Bearer abc.def-123456789')).toBe('Authorization: <secret>')
    expect(scrubString('AIzaSyA1234567890abcdefghijklmnop')).toBe('<secret>')
    expect(scrubString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk')).toBe('jwt <secret>')
  })
  it('長い文は切り詰める（ターミナルの出力や文字起こしが混ざっても全部は出ない）', () => {
    const out = scrubString('x'.repeat(2000))
    expect(out.length).toBeLessThanOrEqual(301)
  })
})

describe('イベントの除去', () => {
  const ctx = { homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/app'] }
  const event = {
    event_id: 'e1',
    message: 'boom at /Users/taro/work/app/feedback.md',
    user: { ip_address: '203.0.113.5', email: 'taro@example.com' },
    server_name: 'taros-macbook.local',
    request: { url: 'https://example.com/page' },
    extra: { transcript: '今日は社外秘の話をします' },
    contexts: {
      os: { name: 'macOS', version: '15.1' },
      device: { arch: 'arm64', name: "Taro's MacBook", model_id: 'Mac15,3', boot_time: '2026-10-02T14:40:18.347Z' },
      app: { app_name: 'MOVIE-ADE' },
      runtime: { name: 'Electron', version: '44.5.1' },
      terminal: { output: 'ls ~/secret' }
    },
    exception: {
      values: [{
        type: 'Error',
        value: 'ENOENT: no such file, open \'/Users/taro/Documents/a.txt\' (taro@example.com)',
        stacktrace: { frames: [{ filename: 'app:///out/main/index.js', abs_path: `/Users/taro/Applications/MOVIE-ADE.app/${'deep/'.repeat(80)}x.js`, function: 'run', lineno: 10 }] }
      }]
    },
    breadcrumbs: [
      { category: 'console', message: 'terminal output: npm run secret' },
      { category: 'ui.click', message: 'button[aria-label="Delete /Users/taro/x"]' },
      { category: 'navigation', data: { from: 'https://a.example', to: 'https://b.example' } },
      { category: 'electron', message: 'app.ready', data: { url: 'https://example.com', title: 'Inbox (3) – taro@example.com' } },
      { category: 'child-process', message: 'whisper exited', data: { type: 'Utility', exitCode: 1, name: 'whisper', cwd: '/Users/taro/work/app' } }
    ]
  }

  it('user・request・extra・server_name を持たない', () => {
    const out = scrubEvent(event, ctx) as Record<string, unknown>
    expect(out.user).toBeUndefined()
    expect(out.request).toBeUndefined()
    expect(out.extra).toBeUndefined()
    expect(out.server_name).toBeUndefined()
  })
  it('OS・CPU・実行環境の版は残し、端末名と知らない contexts は落とす', () => {
    const out = scrubEvent(event, ctx) as { contexts: Record<string, Record<string, unknown>> }
    expect(out.contexts.os).toEqual({ name: 'macOS', version: '15.1' })
    expect(out.contexts.device).toEqual({ arch: 'arm64' })
    expect(out.contexts.runtime?.version).toBe('44.5.1')
    expect(out.contexts.terminal).toBeUndefined()
  })
  it('例外のメッセージからパスとメールを落とす。スタックのファイル名は長くても切らない', () => {
    const out = scrubEvent(event, ctx) as typeof event
    const v = out.exception.values[0]!
    expect(v.value).toBe("ENOENT: no such file, open '~/Documents/a.txt' (<email>)")
    expect(out.message).toBe('boom at <project>/feedback.md')
    expect(v.stacktrace.frames[0]!.filename).toBe('app:///out/main/index.js')
    expect(v.stacktrace.frames[0]!.abs_path.startsWith('~/Applications/MOVIE-ADE.app/')).toBe(true)
    expect(v.stacktrace.frames[0]!.abs_path.endsWith('x.js')).toBe(true)
  })
  it('breadcrumb は electron と子プロセスだけ。URL・タイトル・作業フォルダは落とす', () => {
    const out = scrubEvent(event, ctx) as typeof event
    expect(out.breadcrumbs.map((b) => b.category)).toEqual(['electron', 'child-process'])
    expect(out.breadcrumbs[0]).toEqual({ category: 'electron', message: 'app.ready' })
    expect(out.breadcrumbs[1]!.data).toEqual({ type: 'Utility', exitCode: 1, name: 'whisper' })
  })
  it('Sentry の ID（event_id・trace_id）は秘密の形でも残す', () => {
    const ids = { event_id: 'a'.repeat(32), contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) } } }
    expect(scrubEvent(ids)).toEqual(ids)
  })
  it('元のイベントは書き換えない', () => {
    scrubEvent(event, ctx)
    expect(event.user.email).toBe('taro@example.com')
  })
  it('送ったイベントのどこにもホーム・URL・メールが残らない', () => {
    const json = JSON.stringify(scrubEvent(event, ctx))
    expect(json).not.toMatch(/\/Users\/taro|https?:\/\/|@example\.com|社外秘|taros-macbook/)
  })
  it('beforeBreadcrumb でも同じ規則で落とす', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull()
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: 'https://a' } })).toBeNull()
    expect(scrubBreadcrumb({ category: 'electron', message: 'browser-window.closed /Users/taro/a' }, ctx)).toEqual({ category: 'electron', message: 'browser-window.closed ~/a' })
  })
})

describe('送る量を抑える', () => {
  const err = (value: string) => ({ exception: { values: [{ type: 'Error', value, stacktrace: { frames: [{ filename: 'app:///a.js', function: 'f', lineno: 1 }] } }] } })
  it('同じエラーは1回の起動で1度だけ', () => {
    const allow = createEventLimiter()
    expect(allow(err('a'))).toBe(true)
    expect(allow(err('a'))).toBe(false)
    expect(allow(err('b'))).toBe(true)
  })
  it('1回の起動で送る数に上限がある', () => {
    const allow = createEventLimiter()
    const results = Array.from({ length: MAX_EVENTS_PER_RUN + 5 }, (_, i) => allow(err(`e${i}`)))
    expect(results.filter(Boolean)).toHaveLength(MAX_EVENTS_PER_RUN)
  })
  it('JS の例外は間引き、ネイティブのクラッシュは全部送る', () => {
    expect(sampleEvent(true, () => 0.99)).toBe(true)
    expect(sampleEvent(false, () => 0.99)).toBe(false)
    expect(sampleEvent(false, () => 0.1)).toBe(true)
  })
})

describe('設定の保存', () => {
  it('crashReports は明示の false だけ残し、未設定は ON のまま', async () => {
    const { sanitize } = await import('../../src/main/settings')
    expect(sanitize({ crashReports: false }).crashReports).toBe(false)
    expect(sanitize({ crashReports: true }).crashReports).toBeUndefined()
    expect(sanitize({ crashReports: 'no' }).crashReports).toBeUndefined()
    expect(sanitize({ crashReportsNoticeShown: true }).crashReportsNoticeShown).toBe(true)
    expect(sanitize({}).crashReportsNoticeShown).toBeUndefined()
  })
})
