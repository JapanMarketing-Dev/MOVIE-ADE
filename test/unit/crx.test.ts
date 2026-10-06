import { createSign, generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CrxError, extensionIdFromPublicKey, extractCrx, parseCrx, safeEntryPath } from '../../src/main/crx'
import { isWebStoreDownloadHost, webStoreExtensionId } from '@shared/browserExtensions'

/** テスト用の ZIP（deflate） */
function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const stored = deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    chunks.push(local, nameBytes, stored)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(stored.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + stored.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cd, end])
}

function varint(n: number): Buffer {
  const out: number[] = []
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
  out.push(n)
  return Buffer.from(out)
}
const field = (num: number, bytes: Buffer) => Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes])

function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { spki: publicKey.export({ format: 'der', type: 'spki' }), privateKey }
}

/** CRX3 を組み立てる。signer で署名し、crx_id は idKey の公開鍵から（ずらして偽物を作れる） */
function makeCrx(zip: Buffer, signer = newKey(), idKey = signer, version = 3): { crx: Buffer; id: string } {
  const id = extensionIdFromPublicKey(idKey.spki)
  const idBytes = Buffer.from([...id].map((c) => (c.charCodeAt(0) - 97).toString(16)).join(''), 'hex')
  const signedData = field(1, idBytes)
  const len = Buffer.alloc(4)
  len.writeUInt32LE(signedData.length)
  const sign = createSign('RSA-SHA256')
  sign.update(Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, signedData, zip]))
  const signature = sign.sign(signer.privateKey)
  const header = Buffer.concat([field(2, Buffer.concat([field(1, signer.spki), field(2, signature)])), field(10000, signedData)])
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(version, 4)
  head.writeUInt32LE(header.length, 8)
  return { crx: Buffer.concat([head, header, zip]), id }
}

const ZIP = () => makeZip({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Acme Helper', version: '1.2.3' }), 'popup.html': '<p>hi</p>', 'js/app.js': 'console.log(1)' })

describe('CRX3 packages', () => {
  it('accepts a correctly signed package and returns its extension id', () => {
    const { crx, id } = makeCrx(ZIP())
    expect(id).toMatch(/^[a-p]{32}$/)
    expect(parseCrx(crx).id).toBe(id)
    expect(parseCrx(crx, id).id).toBe(id)
  })

  it('refuses a package for a different extension, a changed ZIP, a signature by another key, CRX2 and non-crx data', () => {
    const { crx, id } = makeCrx(ZIP())
    const other = makeCrx(ZIP())
    expect(() => parseCrx(crx, other.id)).toThrow(CrxError)
    const tampered = Buffer.from(crx)
    tampered[tampered.length - 30] ^= 0xff
    expect(() => parseCrx(tampered, id)).toThrow(CrxError)
    // 別の鍵で署名して、ID だけ本物の拡張のものにした偽物
    const victim = newKey()
    const forged = makeCrx(ZIP(), newKey(), victim)
    expect(() => parseCrx(forged.crx, forged.id)).toThrow(CrxError)
    expect(() => parseCrx(makeCrx(ZIP(), newKey(), undefined, 2).crx)).toThrow(/CRX3/)
    expect(() => parseCrx(Buffer.from('PK\x03\x04not a crx'))).toThrow(CrxError)
  })

  it('extracts with the store key in manifest.json, skips _metadata and refuses paths that leave the folder', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'ferret-crx-')))
    const parsed = parseCrx(makeCrx(ZIP()).crx)
    await extractCrx(parsed, join(dir, 'ok'))
    const manifest = JSON.parse(readFileSync(join(dir, 'ok', 'manifest.json'), 'utf8')) as { key?: string; name: string }
    expect(manifest.name).toBe('Acme Helper')
    expect(manifest.key).toBe(parsed.publicKey.toString('base64'))
    expect(readFileSync(join(dir, 'ok', 'js', 'app.js'), 'utf8')).toBe('console.log(1)')

    const withMeta = parseCrx(makeCrx(makeZip({ 'manifest.json': '{}', '_metadata/verified_contents.json': '[]' })).crx)
    await extractCrx(withMeta, join(dir, 'meta'))
    expect(existsSync(join(dir, 'meta', '_metadata'))).toBe(false)

    const evil = parseCrx(makeCrx(makeZip({ 'manifest.json': '{}', '../escape.txt': 'x' })).crx)
    await expect(extractCrx(evil, join(dir, 'evil'))).rejects.toThrow(CrxError)
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
    expect(existsSync(join(dir, 'evil'))).toBe(false)

    const many = parseCrx(makeCrx(makeZip({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' })).crx)
    await expect(extractCrx(many, join(dir, 'many'), { files: 2, bytes: 1000 })).rejects.toThrow(/too many/)
  })

  it('checks entry names', () => {
    expect(safeEntryPath('js/app.js')).toBe('js/app.js')
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'C:\\x', 'a\\b', 'a\0b', '']) expect(safeEntryPath(bad), bad).toBeNull()
  })
})

describe('Chrome Web Store input', () => {
  const ID = 'cjpalhdlnbpafiamejdnhcphjbkeiagm'
  it('reads the id from store links or the id itself', () => {
    expect(webStoreExtensionId(ID)).toBe(ID)
    expect(webStoreExtensionId(`https://chromewebstore.google.com/detail/ublock-origin/${ID}`)).toBe(ID)
    expect(webStoreExtensionId(`https://chromewebstore.google.com/detail/${ID}?hl=ja`)).toBe(ID)
    expect(webStoreExtensionId(`https://chrome.google.com/webstore/detail/ublock-origin/${ID}`)).toBe(ID)
    for (const bad of ['', 'abc', `http://chromewebstore.google.com/detail/x/${ID}`, `https://evil.example/detail/x/${ID}`, `https://chromewebstore.google.com/search/${ID}`]) {
      expect(webStoreExtensionId(bad), bad).toBeNull()
    }
  })

  it('accepts packages only from Google download hosts', () => {
    for (const ok of ['clients2.google.com', 'clients2.googleusercontent.com', 'edgedl.me.gvt1.com', 'r1---sn-abc.gvt1.com']) expect(isWebStoreDownloadHost(ok), ok).toBe(true)
    for (const ng of ['evil.example', 'google.com.evil.example', 'clients2.google.com.evil.example', 'gvt1.com.evil.example']) expect(isWebStoreDownloadHost(ng), ng).toBe(false)
  })
})
