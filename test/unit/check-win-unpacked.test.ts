import { describe, expect, it } from 'vitest'
import { PE_MACHINE, peMachine } from '../../scripts/check-win-unpacked.mjs'

/** MZ ヘッダと、0x80 に置いた PE ヘッダだけの最小の先頭 */
function peHead(machine: number): Buffer {
  const buf = Buffer.alloc(0x100)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'latin1')
  buf.writeUInt16LE(machine, 0x84)
  return buf
}

describe('peMachine（scripts/check-win-unpacked.mjs）', () => {
  it('PE の Machine を読み、PE でなければ null', () => {
    expect(peMachine(peHead(PE_MACHINE.x64))).toBe(0x8664)
    expect(peMachine(peHead(PE_MACHINE.arm64))).toBe(0xaa64)
    expect(peMachine(Buffer.from('\x7fELF'.padEnd(0x100, '\0'), 'latin1'))).toBeNull()
    const broken = peHead(PE_MACHINE.x64)
    broken.writeUInt32LE(0xfff0, 0x3c)
    expect(peMachine(broken)).toBeNull()
  })
})
