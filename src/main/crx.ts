/**
 * Chrome の拡張のパッケージ（.crx、CRX3 形式）を読み、署名を確かめて、展開済みのフォルダにする。
 * Chrome ウェブストアから取ったもの・利用者が選んだ .crx の両方に使う（browserExtensions.ts）。
 *
 * 確かめること:
 * - 先頭が "Cr24"・版が 3。CRX2 などの古い形式は断る
 * - 署名した部分（signed_header_data の crx_id）と、RSA の公開鍵から決まる拡張の ID が一致し、その鍵の
 *   SHA256 with RSA の署名が「"CRX3 SignedData\x00" + 長さ + signed_header_data + ZIP」に合うこと。
 *   ウェブストアから入れるときは、さらにその ID が利用者の指定した ID と同じこと（配布元や途中で別の拡張に差し替えられない）
 * - 展開は ZIP の中の名前を確かめ（..・絶対パス・\・ドライブ・制御文字は断る）、件数と総量に上限を付け、作るファイルは O_EXCL
 * - manifest.json に key が無ければ公開鍵を入れる（展開済みのフォルダとして読み込んでも、ストアと同じ ID になる）
 */
import { createHash, createPublicKey, createVerify } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openZip } from '@shared/office/zip'

export class CrxError extends Error {}

/** 展開の上限（Chrome から取り込むときと同じ考え。拡張はふつう数 MB） */
export const CRX_LIMITS = { files: 5_000, bytes: 200 * 1024 * 1024, packageBytes: 200 * 1024 * 1024 } as const

interface ProtoField {
  field: number
  wire: number
  value: Buffer | bigint
}

/** protobuf の1段（入れ子は読まない）。読めなければ CrxError */
function readProto(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = []
  let at = 0
  const varint = (): bigint => {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (at >= buf.length || shift > 63n) throw new CrxError('broken crx header')
      const byte = buf[at++]!
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
    }
  }
  while (at < buf.length) {
    const key = varint()
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (wire === 0) out.push({ field, wire, value: varint() })
    else if (wire === 2) {
      const len = Number(varint())
      if (len < 0 || at + len > buf.length) throw new CrxError('broken crx header')
      out.push({ field, wire, value: buf.subarray(at, at + len) })
      at += len
    } else if (wire === 1) { at += 8 } else if (wire === 5) { at += 4 } else throw new CrxError('broken crx header')
  }
  return out
}

/** 公開鍵（SubjectPublicKeyInfo の DER）から Chrome の拡張の ID（SHA256 の先頭16バイトを a〜p で書いたもの） */
export function extensionIdFromPublicKey(spki: Buffer): string {
  const hex = createHash('sha256').update(spki).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

export interface ParsedCrx {
  id: string
  /** 開発者の公開鍵（DER） */
  publicKey: Buffer
  zip: Uint8Array
}

/** CRX3 を確かめて、拡張の ID と中の ZIP を返す。expectedId を渡せば、それと違う拡張は断る */
export function parseCrx(bytes: Uint8Array, expectedId?: string): ParsedCrx {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new CrxError('not a crx file')
  if (buf.readUInt32LE(4) !== 3) throw new CrxError('only CRX3 packages are supported')
  const headerSize = buf.readUInt32LE(8)
  if (12 + headerSize > buf.length) throw new CrxError('truncated crx file')
  const header = buf.subarray(12, 12 + headerSize)
  const zip = buf.subarray(12 + headerSize)
  const fields = readProto(header)
  const signedData = fields.find((f) => f.field === 10000 && f.wire === 2)?.value as Buffer | undefined
  if (!signedData) throw new CrxError('crx has no signed header')
  const crxIdBytes = readProto(signedData).find((f) => f.field === 1 && f.wire === 2)?.value as Buffer | undefined
  if (!crxIdBytes || crxIdBytes.length !== 16) throw new CrxError('crx has no id')
  const crxId = [...crxIdBytes.toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
  if (expectedId && crxId !== expectedId) throw new CrxError('the package is for a different extension')
  // 署名した中身: "CRX3 SignedData\0" + signed_header_data の長さ（4バイト LE）+ signed_header_data + ZIP
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedData.length)
  const signedPrefix = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), length, signedData])
  for (const proof of fields.filter((f) => f.field === 2 && f.wire === 2)) {
    const parts = readProto(proof.value as Buffer)
    const key = parts.find((p) => p.field === 1 && p.wire === 2)?.value as Buffer | undefined
    const signature = parts.find((p) => p.field === 2 && p.wire === 2)?.value as Buffer | undefined
    if (!key || !signature || extensionIdFromPublicKey(key) !== crxId) continue
    let publicKey
    try {
      publicKey = createPublicKey({ key, format: 'der', type: 'spki' })
    } catch {
      continue
    }
    const verify = createVerify('RSA-SHA256')
    verify.update(signedPrefix)
    verify.update(zip)
    if (verify.verify(publicKey, signature)) return { id: crxId, publicKey: key, zip: new Uint8Array(zip) }
  }
  throw new CrxError('the crx signature does not match the extension id')
}

/** ZIP の中の名前を、書いてよい相対パスにする。外へ出る形・Electron が読まない _ 始まりの直下（_metadata）は null */
export function safeEntryPath(name: string): string | null {
  if (!name || name.length > 1024 || /[\0-\x1f\\:]/.test(name) || name.startsWith('/')) return null
  const parts = name.split('/').filter((p) => p !== '')
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) return null
  if (parts[0] === '_metadata') return null
  return parts.join('/')
}

/** 展開する。dest は空のフォルダ（無ければ作る）。失敗したら作りかけを消して投げる */
export async function extractCrx(crx: ParsedCrx, dest: string, limits: { files: number; bytes: number } = CRX_LIMITS): Promise<void> {
  const zip = openZip(crx.zip)
  let files = 0
  let bytes = 0
  try {
    await mkdir(dest, { recursive: true })
    for (const name of zip.names()) {
      if (name.endsWith('/')) continue
      const rel = safeEntryPath(name)
      if (!rel) {
        if (name.split('/')[0] === '_metadata') continue
        throw new CrxError(`unsafe path in the package: ${name.slice(0, 100)}`)
      }
      files += 1
      if (files > limits.files) throw new CrxError('the package has too many files')
      let data = await zip.bytes(name)
      if (!data) continue
      bytes += data.length
      if (bytes > limits.bytes) throw new CrxError('the package is too large')
      // ストアの manifest には key が無い。入れておくと、展開済みとして読み込んでもストアと同じ ID になる
      if (rel === 'manifest.json') data = withManifestKey(data, crx.publicKey)
      const target = join(dest, ...rel.split('/'))
      await mkdir(dirname(target), { recursive: true })
      const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0), 0o644)
      try {
        await out.writeFile(data)
      } finally {
        await out.close()
      }
    }
  } catch (err) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

function withManifestKey(data: Uint8Array, publicKey: Buffer): Uint8Array {
  try {
    const text = Buffer.from(data).toString('utf8').replace(/^﻿/, '')
    const manifest = JSON.parse(text) as Record<string, unknown>
    if (typeof manifest.key === 'string' && manifest.key) return data
    return Buffer.from(JSON.stringify({ ...manifest, key: publicKey.toString('base64') }, null, 2), 'utf8')
  } catch {
    // 読めない manifest はそのまま（読み込みのときに理由が出る）
    return data
  }
}
