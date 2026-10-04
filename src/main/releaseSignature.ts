import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto'

/**
 * 配布物の SHA256SUMS の署名を、アプリに同梱した公開鍵で確かめる（security-3 [2]）。
 *
 * 配布物・manifest・latest.json は同じ R2 に置くので、R2 を書き換えられると全部を差し替えられる。
 * 署名の鍵は R2 の書き込みとは別に持ち（scripts/release-signing.mjs）、公開鍵は R2 の外（このアプリ・リポジトリ）にだけ置く。
 * 更新の確認は、署名の合う SHA256SUMS に latest.json のファイルの sha256 が載っているときだけ「新しい版がある」と案内する。
 * 形は OpenSSH の SSHSIG（PROTOCOL.sshsig）。署名する側は scripts/release-signing.mjs（同じ形を単体テストで突き合わせる）。
 */

/** 署名者・用途。scripts/release-signing.mjs と build/release-signing/allowed_signers と同じ（単体テストで確かめる） */
export const RELEASE_SIGNER_IDENTITY = 'release@ferretade.dev'
export const RELEASE_SIGNING_NAMESPACE = 'ferret-release'
/** 信じる公開鍵（build/release-signing/allowed_signers と同じ。鍵を替えるときは両方とテストを直す） */
export const RELEASE_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpXERU8ST0MEOIMbzoL4zShkjIrMB4++NL3xBohKAS9'
/** SHA256SUMS と署名の上限（数十行の文字だけなので小さい） */
export const SIGNED_SUMS_MAX_BYTES = 64 * 1024

function sshString(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  return Buffer.concat([len, body])
}

class SshReader {
  private at = 0
  constructor(private readonly buf: Buffer) {}
  string(): Buffer {
    const len = this.uint32()
    if (this.at + len > this.buf.length) throw new Error('truncated')
    const out = this.buf.subarray(this.at, this.at + len)
    this.at += len
    return out
  }
  uint32(): number {
    if (this.at + 4 > this.buf.length) throw new Error('truncated')
    const v = this.buf.readUInt32BE(this.at)
    this.at += 4
    return v
  }
  raw(n: number): Buffer {
    if (this.at + n > this.buf.length) throw new Error('truncated')
    const out = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
  done(): boolean {
    return this.at === this.buf.length
  }
}

/** "ssh-ed25519 AAAA…" → [SSH の公開鍵の塊, KeyObject] */
function parsePublicKey(line: string): { blob: Buffer; key: KeyObject } {
  const [type, b64] = line.trim().split(/\s+/)
  if (type !== 'ssh-ed25519' || !b64) throw new Error('not an ssh-ed25519 key')
  const blob = Buffer.from(b64, 'base64')
  const r = new SshReader(blob)
  if (r.string().toString() !== 'ssh-ed25519') throw new Error('not an ssh-ed25519 key')
  const raw = r.string()
  if (raw.length !== 32 || !r.done()) throw new Error('bad ssh-ed25519 key')
  return { blob, key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }) }
}

/**
 * SSHSIG の署名を確かめる。鍵・用途・ハッシュの種類まで合わなければ false（壊れた入力でも例外を投げない）。
 * 署名の中に入っている鍵は信じず、trustedKey と同じかを比べる
 */
export function verifySshSignature(message: Buffer, armored: string, trustedKey: string = RELEASE_PUBLIC_KEY, namespace: string = RELEASE_SIGNING_NAMESPACE): boolean {
  try {
    const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(armored)
    if (!m) return false
    const r = new SshReader(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64'))
    if (r.raw(6).toString() !== 'SSHSIG' || r.uint32() !== 1) return false
    const embedded = r.string()
    const ns = r.string().toString()
    r.string() // reserved
    const hash = r.string().toString()
    const sigBlob = r.string()
    if (!r.done() || ns !== namespace || hash !== 'sha512') return false
    const trusted = parsePublicKey(trustedKey)
    if (!trusted.blob.equals(embedded)) return false
    const s = new SshReader(sigBlob)
    if (s.string().toString() !== 'ssh-ed25519') return false
    const sig = s.string()
    if (sig.length !== 64 || !s.done()) return false
    const digest = createHash('sha512').update(message).digest()
    const signed = Buffer.concat([Buffer.from('SSHSIG'), sshString(namespace), sshString(''), sshString('sha512'), sshString(digest)])
    return edVerify(null, signed, trusted.key, sig)
  } catch {
    return false
  }
}

/** SHA256SUMS（`sha256sum` の出力）→ 名前 → sha256。読めない行があれば null */
export function parseSignedSums(text: string): Map<string, string> | null {
  const sums = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line.trimEnd())
    if (!m || sums.has(m[2]!)) return null
    sums.set(m[2]!, m[1]!)
  }
  return sums.size > 0 ? sums : null
}

/** インストーラーの大きさの上限（R2 に一度に上げられる 300 MiB に余裕を足したもの） */
export const MAX_INSTALLER_BYTES = 400 * 1024 * 1024

/** 製品名（配布物の名前の先頭）。scripts/release-r2-lib.mjs の PRODUCTS の今の名前 */
export const RELEASE_PRODUCT = 'Ferret'

const ARCH_OF: Record<string, 'arm64' | 'x64'> = { arm64: 'arm64', aarch64: 'arm64', x64: 'x64', x86_64: 'x64', amd64: 'x64' }
const KIND_OF = { dmg: 'dmg', exe: 'exe', AppImage: 'AppImage', deb: 'deb' } as const

/** 署名で確かめた1ファイル。os / arch / kind / path は署名した名前と版から作る（manifest の値は使わない） */
export interface SignedReleaseFile {
  name: string
  sha256: string
  size: number
  os: 'mac' | 'win' | 'linux'
  arch: 'arm64' | 'x64'
  kind: 'dmg' | 'exe' | 'AppImage' | 'deb'
  path: string
}

/**
 * 配布物の名前（Ferret-<版>-<os>-<arch>.<ext>）を、決まった版として読む。別の版・別の製品・別の形は null。
 * 署名した SHA256SUMS の名前に版・OS・CPU・種類が入っているので、名前を読めば署名された身元が分かる
 */
export function parseSignedArtifactName(name: string, version: string): Pick<SignedReleaseFile, 'os' | 'arch' | 'kind'> | null {
  const escaped = version.replace(/[.+]/g, (c) => `\\${c}`)
  const m = new RegExp(`^${RELEASE_PRODUCT}-${escaped}-(mac|win|linux)-([A-Za-z0-9_]+)\\.(dmg|exe|AppImage|deb)$`).exec(name)
  const arch = m ? ARCH_OF[m[2]!] : undefined
  if (!m || !arch) return null
  return { os: m[1] as SignedReleaseFile['os'], arch, kind: KIND_OF[m[3] as keyof typeof KIND_OF] }
}

/**
 * latest.json のファイルを、署名の合う SHA256SUMS と突き合わせる（security-3 [2]・security-4 [3]）。
 * - 署名が合う
 * - SHA256SUMS の名前の集まりと manifest のファイルが過不足なく同じで、sha256 も同じ
 * - どの名前も、その版（SHA256SUMS を取った releases/<版>/ の版）の配布物の名前（別の版の署名を使い回させない）
 * - path は releases/<版>/<名前>（作り直しは releases/<版>/b<n>/<名前>）だけ。OS・CPU・種類は名前から読む
 * どれか1つでも合わなければ null（その版は案内しない）。大きさは署名に入らないので、上限としてだけ使い、
 * 中身はダウンロードのあとで sha256 を確かめる（updateDownload.ts）
 */
export function verifiedReleaseFiles(
  version: string,
  files: ReadonlyArray<{ name: string; sha256: string; path: string; size: number }>,
  sums: Buffer,
  signature: string,
  trustedKey: string = RELEASE_PUBLIC_KEY
): SignedReleaseFile[] | null {
  if (!verifySshSignature(sums, signature, trustedKey)) return null
  const table = parseSignedSums(sums.toString('utf8'))
  if (!table || files.length === 0 || table.size !== files.length) return null
  for (const name of table.keys()) if (!parseSignedArtifactName(name, version)) return null
  const dir = `releases/${version}/`
  const out: SignedReleaseFile[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const identity = parseSignedArtifactName(f.name, version)
    if (!identity || seen.has(f.name) || table.get(f.name) !== f.sha256) return null
    seen.add(f.name)
    const rest = f.path.startsWith(dir) ? f.path.slice(dir.length) : null
    if (rest !== f.name && !(rest !== null && /^b\d{1,3}\//.test(rest) && rest.slice(rest.indexOf('/') + 1) === f.name)) return null
    if (!Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_INSTALLER_BYTES) return null
    out.push({ name: f.name, sha256: f.sha256, size: f.size, path: f.path, ...identity })
  }
  return out
}
