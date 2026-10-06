import { describe, expect, it } from 'vitest'
import { parseMinidumpCrash } from '../../src/shared/minidump'
import { memoryBucket, minimizeNativeCrash, scrubEvent, uptimeBucket } from '../../src/shared/telemetry'

/**
 * main のネイティブのクラッシュ（FERRET-12、0.4.16 の Windows）は、minidump を捨てていたので原因が分からなかった。
 * minidump から例外の種類と落ちた場所のモジュール名だけを読み、落ちる前のメモリの量の区分と一緒にタグにする
 */

/** 例外・モジュール一覧・SystemInfo の3つの stream を持つ最小の minidump を作る */
function minidump(opts: { code: number; address: bigint; platformId?: number; modules?: Array<{ base: bigint; size: number; name: string }> }): Uint8Array {
  const modules = opts.modules ?? []
  const headerSize = 32
  const dirSize = 3 * 12
  const exceptionAt = headerSize + dirSize
  const exceptionSize = 168
  const systemAt = exceptionAt + exceptionSize
  const systemSize = 56
  const modulesAt = systemAt + systemSize
  const modulesSize = 4 + modules.length * 108
  let namesAt = modulesAt + modulesSize
  const names = modules.map((m) => {
    const bytes = Buffer.from(m.name, 'utf16le')
    const at = namesAt
    namesAt += 4 + bytes.length
    return { at, bytes }
  })
  const buf = Buffer.alloc(namesAt)
  buf.write('MDMP', 0, 'latin1')
  buf.writeUInt32LE(3, 8)
  buf.writeUInt32LE(headerSize, 12)
  const dir = (i: number, type: number, size: number, rva: number) => {
    buf.writeUInt32LE(type, headerSize + i * 12)
    buf.writeUInt32LE(size, headerSize + i * 12 + 4)
    buf.writeUInt32LE(rva, headerSize + i * 12 + 8)
  }
  dir(0, 6, exceptionSize, exceptionAt)
  dir(1, 7, systemSize, systemAt)
  dir(2, 4, modulesSize, modulesAt)
  buf.writeUInt32LE(opts.code, exceptionAt + 8)
  buf.writeBigUInt64LE(opts.address, exceptionAt + 24)
  buf.writeUInt32LE(opts.platformId ?? 2, systemAt + 24)
  buf.writeUInt32LE(modules.length, modulesAt)
  modules.forEach((m, i) => {
    const at = modulesAt + 4 + i * 108
    buf.writeBigUInt64LE(m.base, at)
    buf.writeUInt32LE(m.size, at + 8)
    buf.writeUInt32LE(names[i].at, at + 20)
    buf.writeUInt32LE(names[i].bytes.length, names[i].at)
    names[i].bytes.copy(buf, names[i].at + 4)
  })
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

const MODULES = [
  { base: 0x7ff600000000n, size: 0x1000000, name: 'C:\\Users\\someone\\AppData\\Local\\Programs\\Ferret\\Ferret.exe' },
  { base: 0x7ffa00000000n, size: 0x100000, name: 'C:\\Users\\someone\\AppData\\Local\\Programs\\Ferret\\resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\Release\\pty.node' }
]

describe('minidump から落ちた理由を読む', () => {
  it('Windows のアクセス違反と、落ちた場所のモジュールのファイル名（パスは持たない）', () => {
    const out = parseMinidumpCrash(minidump({ code: 0xc0000005, address: 0x7ffa00000123n, modules: MODULES }))
    expect(out).toEqual({ code: '0xc0000005', kind: 'access-violation', module: 'pty.node' })
    expect(JSON.stringify(out)).not.toContain('someone')
  })

  it('Chromium のメモリ不足（0xe0000008）は oom', () => {
    expect(parseMinidumpCrash(minidump({ code: 0xe0000008, address: 0x7ff600000010n, modules: MODULES }))).toEqual({ code: '0xe0000008', kind: 'oom', module: 'ferret.exe' })
  })

  it('macOS と Linux は番号の意味が違う', () => {
    expect(parseMinidumpCrash(minidump({ code: 1, address: 0n, platformId: 0x8101 }))).toEqual({ code: '0x1', kind: 'bad-access' })
    expect(parseMinidumpCrash(minidump({ code: 11, address: 0n, platformId: 0x8201 }))).toEqual({ code: '0xb', kind: 'sigsegv' })
  })

  it('知らない番号は番号だけ、どのモジュールにも入らない番地はモジュール名なし', () => {
    expect(parseMinidumpCrash(minidump({ code: 0x12345678, address: 0x10n, modules: MODULES }))).toEqual({ code: '0x12345678' })
  })

  it('形の違うモジュール名は送らない', () => {
    const odd = [{ base: 0x1000n, size: 0x1000, name: 'C:\\x\\name with spaces.dll' }]
    expect(parseMinidumpCrash(minidump({ code: 0xc0000005, address: 0x1010n, modules: odd }))).toEqual({ code: '0xc0000005', kind: 'access-violation' })
  })

  it('minidump でないもの・途中で切れたものは null', () => {
    expect(parseMinidumpCrash(new Uint8Array(10))).toBeNull()
    expect(parseMinidumpCrash(new TextEncoder().encode('not a minidump at all, just text....'))).toBeNull()
    const full = minidump({ code: 0xc0000005, address: 0x7ffa00000123n, modules: MODULES })
    expect(parseMinidumpCrash(full.subarray(0, 80))).toBeNull()
  })
})

describe('ネイティブのクラッシュに理由と落ちる前の様子を付ける', () => {
  const crash = (extra: Record<string, unknown> = {}) => ({
    level: 'fatal',
    platform: 'native',
    tags: { 'event.environment': 'native', 'event.process': 'browser', 'mem.rss': '1-2GB', 'mem.heap': '512MB-1GB', uptime: '1-4h', 'os.platform': 'win32', secret: 'x' },
    contexts: { electron: { details: { reason: 'unknown' } } },
    ...extra
  })

  it('例外の種類・モジュール・メモリと起動からの時間の区分をタグに、まとめ方にも種類を入れる', () => {
    const out = minimizeNativeCrash(crash(), { code: '0xc0000005', kind: 'access-violation', module: 'pty.node' }) as unknown as { message: string; fingerprint: string[]; tags: Record<string, string> }
    expect(out.tags).toMatchObject({ 'crash.code': '0xc0000005', 'crash.kind': 'access-violation', 'crash.module': 'pty.node', 'mem.rss': '1-2GB', 'mem.heap': '512MB-1GB', uptime: '1-4h' })
    expect(out.tags.secret).toBeUndefined()
    expect(out.message).toBe('Native crash (browser, unknown): access-violation in pty.node')
    expect(out.fingerprint).toEqual(['native-crash', 'browser', 'unknown', 'access-violation', 'pty.node'])
  })

  it('Electron の V8 のメモリ不足の注釈は oom にする（注釈の中身は送らない）', () => {
    const e = crash({ contexts: { electron: { details: { reason: 'oom' }, 'crashpad.electron.v8-oom.stack': '#0 /Users/someone/x.js' } } })
    const out = scrubEvent(minimizeNativeCrash(e)) as { tags: Record<string, string> }
    expect(out.tags['crash.kind']).toBe('oom')
    expect(JSON.stringify(out)).not.toContain('someone')
  })

  it('区分の形でないメモリの値は落とす', () => {
    const e = crash()
    e.tags['mem.rss'] = '/Users/someone'
    const out = minimizeNativeCrash(e) as { tags: Record<string, string> }
    expect(out.tags['mem.rss']).toBeUndefined()
  })

  it('区分の関数が返す値は全部そのまま通る', () => {
    const values = [...[10, 300, 700, 1500, 3000].map(memoryBucket), ...[10, 100, 1000, 7200, 20000, 100000].map(uptimeBucket)]
    for (const v of values) {
      const e = crash()
      e.tags['mem.rss'] = v
      e.tags.uptime = v
      const out = minimizeNativeCrash(e) as { tags: Record<string, string> }
      expect(out.tags['mem.rss']).toBe(v)
    }
  })
})
