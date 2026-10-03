import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ATTACHMENTS,
  filterEnvelope,
  filterTransport,
  gateTransport,
  isAllowedAttachment,
  isNativeCrashEvent,
  minimizeNativeCrash,
  scrubEvent
} from '../../src/shared/telemetry'

/**
 * ネイティブのクラッシュの minidump（メモリの写し）は伏せ字を通せないので送らない（security-2 [13]）。
 * 守る場所は2つ：main の beforeSend（届いた添付を全部捨てる・minimizeNativeCrash）と、transport の filterEnvelope。
 */
const MINIDUMP = new Uint8Array([0x4d, 0x44, 0x4d, 0x50, 0x73, 0x6b, 0x2d, 0x6c, 0x69, 0x76, 0x65])
type Item = [Record<string, unknown>, unknown]
const envelope = (...items: Item[]) => [{ event_id: 'a'.repeat(32), sent_at: '2026-10-03T00:00:00Z' }, items] as const
const sentThrough = async (env: unknown) => {
  const sent: unknown[] = []
  const transport = gateTransport({ send: async (e: never) => { sent.push(e); return {} }, flush: async () => true }, () => true)
  await transport.send(env as never)
  return sent
}

describe('security-2 [13] 添付', () => {
  it('security-2 [13] minidump の添付は transport で落ちる（イベントは残る）', async () => {
    const env = envelope(
      [{ type: 'event' }, { message: 'Native crash (browser)' }],
      [{ type: 'attachment', filename: 'upload_file_minidump', attachment_type: 'event.minidump', length: MINIDUMP.length }, MINIDUMP]
    )
    const sent = await sentThrough(env)
    expect(sent).toHaveLength(1)
    const items = (sent[0] as [unknown, Item[]])[1]
    expect(items.map(([h]) => h.type)).toEqual(['event'])
    expect(JSON.stringify(sent)).not.toContain('event.minidump')
  })

  it('security-2 [13] 名前を main-log.txt にした minidump も通さない', () => {
    expect(isAllowedAttachment({ filename: 'main-log.txt', attachmentType: 'event.minidump' })).toBe(false)
    expect(filterEnvelope(envelope([{ type: 'attachment', filename: 'main-log.txt', attachment_type: 'event.minidump' }, MINIDUMP]))).toBeNull()
  })

  it('security-2 [13] 許す添付は伏せ字済みの main のログだけ', () => {
    expect([...ALLOWED_ATTACHMENTS]).toEqual(['main-log.txt'])
    expect(isAllowedAttachment({ filename: 'main-log.txt' })).toBe(true)
    expect(isAllowedAttachment({ filename: 'main-log.txt', attachmentType: 'event.attachment' })).toBe(true)
    for (const filename of ['screenshot.png', 'view-hierarchy.json', 'upload_file_minidump', 'renderer-log.txt', undefined]) {
      expect(isAllowedAttachment({ filename })).toBe(false)
    }
  })

  it('security-2 [13] beforeSend を通らない項目（span・profile・feedback・replay・transaction）は送らない', async () => {
    for (const type of ['span', 'profile', 'profile_chunk', 'feedback', 'replay_event', 'replay_recording', 'transaction', 'check_in', 'statsd', 'log']) {
      expect(await sentThrough(envelope([{ type }, { text: 'C:\\Users\\someone\\secret.txt' }]))).toEqual([])
    }
  })

  it('security-2 [13] セッション・送れなかった数・イベントは送る', async () => {
    const env = envelope([{ type: 'session' }, { status: 'ok' }], [{ type: 'sessions' }, {}], [{ type: 'client_report' }, {}], [{ type: 'event' }, {}])
    const sent = await sentThrough(env)
    expect((sent[0] as [unknown, Item[]])[1]).toHaveLength(4)
  })

  it('security-2 [13] envelope の形でないものは送らない', async () => {
    for (const bad of ['raw', null, [{}], [{}, 'items'], { 0: {}, 1: [] }, MINIDUMP]) {
      expect(await sentThrough(bad)).toEqual([])
    }
  })
})

describe('security-2 [13] ネイティブのクラッシュ', () => {
  type Minimal = { message?: string; fingerprint?: string[]; tags?: Record<string, string>; contexts?: unknown; release?: string }
  const minimize = (event: object) => minimizeNativeCrash(event) as Minimal
  const crashEvent = () => ({
    event_id: 'b'.repeat(32),
    timestamp: 1_790_000_000,
    level: 'fatal',
    platform: 'native',
    release: 'ferret@0.2.0',
    environment: 'production',
    user: { id: '7a052e6b-d753-4b3d-9fa5-8ff07d326013' },
    tags: { 'event.environment': 'native', 'event.process': 'main-window', 'exit.reason': 'crashed', 'os.platform': 'darwin', arch: 'arm64', note: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
    contexts: {
      electron: {
        crashed_url: 'https://example.com/private?token=abc',
        details: { reason: 'crashed', exitCode: 11 },
        'crashpad.url-chunk-1': 'https://internal.example/page',
        'crashpad.prod': 'Electron'
      },
      app: { app_version: '0.2.0', app_arch: 'arm64', app_name: 'Ferret', app_start_time: '2026-10-03T00:00:00Z' },
      os: { name: 'macOS', version: '26.6.2', kernel_version: '25.6.0' },
      runtime: { name: 'Electron' }
    },
    breadcrumbs: [{ category: 'flow', message: 'open /Users/someone/acme-shop/.env' }],
    exception: { values: [{ type: 'OutOfMemoryError', value: 'Renderer reached heap limit', stacktrace: { frames: [{ filename: '/Users/someone/app.js' }] } }] },
    extra: { terminal: 'export OPENAI_API_KEY=sk-live' }
  })

  it('security-2 [13] プロセスの種類・終了の理由・版だけを残す', () => {
    const out = minimize(crashEvent())
    expect(out.message).toBe('Native crash (main-window, crashed)')
    expect(out.fingerprint).toEqual(['native-crash', 'main-window', 'crashed'])
    expect(out.tags).toEqual({ 'event.environment': 'native', 'event.process': 'main-window', 'exit.reason': 'crashed', 'os.platform': 'darwin', arch: 'arm64' })
    expect(out.contexts).toEqual({ electron: { details: { reason: 'crashed', exitCode: 11 } }, app: { app_version: '0.2.0', app_arch: 'arm64' }, os: { name: 'macOS', version: '26.6.2' } })
    expect(out.release).toBe('ferret@0.2.0')
    expect(Object.keys(out).sort()).toEqual(['contexts', 'environment', 'event_id', 'fingerprint', 'level', 'message', 'platform', 'release', 'tags', 'timestamp', 'user'])
  })

  it('security-2 [13] crashpad の注釈・URL・パンくず・スタック・extra が残らない', () => {
    const json = JSON.stringify(scrubEvent(minimizeNativeCrash(crashEvent())))
    for (const leaked of ['crashpad', 'example.com', 'internal.example', 'acme-shop', '/Users/someone', 'sk-ant', 'OPENAI', 'OutOfMemoryError']) {
      expect(json).not.toContain(leaked)
    }
  })

  it('security-2 [13] 決まりの形でないプロセス名・理由は unknown にする', () => {
    const e = crashEvent()
    e.tags['event.process'] = 'https://example.com/page?q=1'
    e.tags['exit.reason'] = '/Users/someone/x'
    e.contexts.electron.details.reason = 'x y'
    const out = minimize(e)
    expect(out.message).toBe('Native crash (unknown)')
    expect(out.tags?.['event.process']).toBe('unknown')
  })

  it('security-2 [13] minidump の添付・platform・タグのどれかでネイティブのクラッシュと見分ける', () => {
    expect(isNativeCrashEvent({}, true)).toBe(true)
    expect(isNativeCrashEvent({ platform: 'native' }, false)).toBe(true)
    expect(isNativeCrashEvent({ tags: { 'event.environment': 'native' } }, false)).toBe(true)
    expect(isNativeCrashEvent({ platform: 'javascript', tags: { kind: 'ipc' } }, false)).toBe(false)
  })

  it('security-2 [13] ふつうのイベントでも electron の contexts は終了の情報だけ', () => {
    const out = scrubEvent({ contexts: { electron: { crashed_url: 'https://example.com', 'crashpad.annot': 'x', details: { reason: 'oom', exitCode: 1, url: 'https://example.com' } } } }) as { contexts: Record<string, unknown> }
    expect(out.contexts.electron).toEqual({ details: { reason: 'oom', exitCode: 1 } })
  })
})

describe('security-2 [13] main の Sentry の設定（伏せ字を通らない経路がない）', () => {
  const source = readFileSync(resolve(__dirname, '../../src/main/telemetry.ts'), 'utf8')
  const beforeSend = source.slice(source.indexOf('beforeSend:'), source.indexOf('installProcessHooks()', source.indexOf('beforeSend:')))

  it('security-2 [13] transport は gateTransport（filterEnvelope）で包む', () => {
    expect(source).toMatch(/transport: \(options\) => gateTransport\(/)
  })

  it('security-2 [13] オフラインの置き場から後で送るもの（前の版がためた minidump）も filterTransport を通る', () => {
    expect(source).toMatch(/makeElectronOfflineTransport\(\(o\) => filterTransport\(Sentry\.makeElectronTransport\(o\)\)\)/)
  })

  it('security-2 [13] filterTransport は minidump を落とし、何も残らなければ送らない', async () => {
    const sent: unknown[] = []
    const transport = filterTransport({ send: async (e: never) => { sent.push(e); return {} } })
    await transport.send(envelope([{ type: 'attachment', filename: 'upload_file_minidump', attachment_type: 'event.minidump' }, MINIDUMP]) as never)
    await transport.send(envelope([{ type: 'event' }, {}], [{ type: 'attachment', filename: 'upload_file_minidump', attachment_type: 'event.minidump' }, MINIDUMP]) as never)
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent)).not.toContain('minidump')
  })

  it('security-2 [13] beforeSend は届いた添付を全部捨て、ネイティブのクラッシュを小さくしてから伏せ字を通す', () => {
    const cleared = beforeSend.indexOf('hint.attachments = []')
    expect(cleared).toBeGreaterThan(-1)
    expect(beforeSend.indexOf('minimizeNativeCrash(event)')).toBeGreaterThan(cleared)
    // 後から足す添付は main のログだけで、ネイティブのクラッシュには付けない
    expect(beforeSend.match(/hint\.attachments = \[/g)).toHaveLength(2)
    expect(beforeSend).toMatch(/!native && isCrashEvent\(event, false\)[\s\S]*filename: 'main-log\.txt'/)
    expect(beforeSend.trimEnd()).toMatch(/return scrubEvent\(event, scrubContext\(\)\)\s*\}\s*\}\)$/)
  })
})
