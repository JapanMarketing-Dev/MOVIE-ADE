/**
 * minidump から「なぜ落ちたか」の手がかりだけを読む（例外の種類と、落ちた場所のモジュールの名前）。
 * minidump 本体（メモリの写し）は送らない（security-2 [13]）。ここで読んだ短い値だけをタグにする。
 *
 * 形式: https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/
 * Crashpad は macOS・Linux でも同じ形で書く（例外の番号は OS ごとに意味が違うので SystemInfo で見分ける）
 */

export interface MinidumpCrash {
  /** 例外の番号（16進。例 0xc0000005） */
  code: string
  /** 例外の名前（分かるものだけ。例 access-violation・oom） */
  kind?: string
  /** 落ちた場所のモジュールのファイル名（パスは持たない。例 node.dll・pty.node） */
  module?: string
}

const STREAM_MODULE_LIST = 4
const STREAM_EXCEPTION = 6
const STREAM_SYSTEM_INFO = 7
const MODULE_SIZE = 108
const MAX_STREAMS = 256
const MAX_MODULES = 2000
const MAX_NAME_BYTES = 2048

/** Windows の例外の番号（NTSTATUS と Chromium の決まり） */
const WINDOWS_KINDS: Record<number, string> = {
  0xc0000005: 'access-violation',
  0xc00000fd: 'stack-overflow',
  0xc0000409: 'fast-fail',
  0xc0000374: 'heap-corruption',
  0xc0000017: 'no-memory',
  0xc000001d: 'illegal-instruction',
  0xc0000094: 'divide-by-zero',
  0x80000003: 'breakpoint',
  // Chromium の base::TerminateBecauseOutOfMemory（V8 のヒープの上限・確保の失敗）
  0xe0000008: 'oom',
  0xe06d7363: 'cpp-exception',
  // ウインドウのコールバックの中で起きた例外（STATUS_FATAL_USER_CALLBACK_EXCEPTION）
  0xc000041d: 'fatal-user-callback'
}

/** macOS の mach の例外の種類 */
const MAC_KINDS: Record<number, string> = { 1: 'bad-access', 2: 'bad-instruction', 3: 'arithmetic', 5: 'software', 6: 'breakpoint', 10: 'crash', 11: 'resource', 12: 'guard' }
/** Linux のシグナル */
const LINUX_KINDS: Record<number, string> = { 4: 'sigill', 5: 'sigtrap', 6: 'sigabrt', 7: 'sigbus', 8: 'sigfpe', 9: 'sigkill', 11: 'sigsegv' }

const MODULE_NAME = /^[A-Za-z0-9_.+-]{1,40}$/

/** 読めない・形が違うものは null（送るものを増やさない） */
export function parseMinidumpCrash(input: Uint8Array): MinidumpCrash | null {
  try {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const len = input.byteLength
    const u32 = (at: number): number => {
      if (at < 0 || at + 4 > len) throw new RangeError('out of range')
      return view.getUint32(at, true)
    }
    const u64 = (at: number): bigint => {
      if (at < 0 || at + 8 > len) throw new RangeError('out of range')
      return view.getBigUint64(at, true)
    }
    if (len < 32 || u32(0) !== 0x504d444d) return null // 'MDMP'
    const streams = Math.min(u32(8), MAX_STREAMS)
    const dir = u32(12)
    let exceptionAt = -1
    let modulesAt = -1
    let platformId = -1
    for (let i = 0; i < streams; i += 1) {
      const at = dir + i * 12
      const type = u32(at)
      const rva = u32(at + 8)
      if (type === STREAM_EXCEPTION) exceptionAt = rva
      else if (type === STREAM_MODULE_LIST) modulesAt = rva
      else if (type === STREAM_SYSTEM_INFO) platformId = u32(rva + 24)
    }
    if (exceptionAt < 0) return null
    // MINIDUMP_EXCEPTION_STREAM: ThreadId, align, MINIDUMP_EXCEPTION { Code, Flags, Record(u64), Address(u64), ... }
    const rawCode = u32(exceptionAt + 8)
    const address = u64(exceptionAt + 24)
    const code = `0x${rawCode.toString(16).padStart(platformId === 2 || platformId < 0 ? 8 : 1, '0')}`
    const table = platformId === 0x8101 ? MAC_KINDS : platformId === 0x8201 ? LINUX_KINDS : WINDOWS_KINDS
    const kind = table[rawCode]
    const out: MinidumpCrash = { code, ...(kind ? { kind } : {}) }
    if (modulesAt >= 0) {
      const count = Math.min(u32(modulesAt), MAX_MODULES)
      for (let i = 0; i < count; i += 1) {
        const at = modulesAt + 4 + i * MODULE_SIZE
        const base = u64(at)
        const size = BigInt(u32(at + 8))
        if (address < base || address >= base + size) continue
        const name = readModuleName(input, u32, u32(at + 20))
        if (name) out.module = name
        break
      }
    }
    return out
  } catch {
    // 壊れた・途中までの minidump（想定内）
    return null
  }
}

/** MINIDUMP_STRING（バイト数＋UTF-16LE）からファイル名だけを取る */
function readModuleName(input: Uint8Array, u32: (at: number) => number, rva: number): string | undefined {
  const bytes = u32(rva)
  if (bytes === 0 || bytes > MAX_NAME_BYTES || bytes % 2 !== 0 || rva + 4 + bytes > input.byteLength) return undefined
  const full = new TextDecoder('utf-16le').decode(input.subarray(rva + 4, rva + 4 + bytes))
  const name = full.split(/[\\/]/).pop() ?? ''
  return MODULE_NAME.test(name) ? name.toLowerCase() : undefined
}
