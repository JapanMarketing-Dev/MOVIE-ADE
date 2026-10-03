/**
 * 配布物の SHA256SUMS に、R2 とは別の鍵で署名する（security-3 [2]）。
 *
 * 配布物（インストーラー）と manifest は同じ R2 に置くので、R2 を書き換えられると両方を差し替えられる。
 * そこで、R2 の書き込みの権限とは別に持つ Ed25519 の鍵で SHA256SUMS に署名し、公開鍵を R2 の外
 * （このリポジトリの build/release-signing/allowed_signers、アプリの中の src/main/releaseSignature.ts、SECURITY.md）に置く。
 * 署名の形は OpenSSH の SSHSIG（PROTOCOL.sshsig）。利用者は OS に入っている ssh-keygen で確かめられる:
 *
 *   ssh-keygen -Y verify -f allowed_signers -I release@ferretade.dev -n ferret-release -s SHA256SUMS.sig < SHA256SUMS
 *
 * 使い方:
 *   node scripts/release-signing.mjs keygen --out <フォルダ>
 *     → <フォルダ>/release-signing-key.pem（秘密鍵。0600。リポジトリ・R2 には置かない）と allowed_signers を作る
 *   node scripts/release-signing.mjs sign --sums SHA256SUMS --out SHA256SUMS.sig [--key <pem>]
 *     → 鍵は環境変数 RELEASE_SIGNING_KEY（PEM の中身。CI の secret）か --key のファイル（手元は ~/.ferret-signing/release-signing-key.pem）
 *   node scripts/release-signing.mjs verify --sums SHA256SUMS --sig SHA256SUMS.sig
 *     → リポジトリに固定した公開鍵（allowed_signers）で確かめる。合わなければ 1 で終わる
 *
 * 鍵を持つのは GitHub Actions の checksums ジョブ（R2 のトークンを持たない）と、公開する人の手元だけ。
 * R2 のトークンを持つ stage / promote は鍵を持たず、署名を確かめるだけ（test/unit/release-policy.test.ts が確かめる）。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 署名の用途（ssh-keygen -n）。ほかの用途の署名を流用させない */
export const SIGNING_NAMESPACE = 'ferret-release'
/** 署名者の名前（allowed_signers の1列目、ssh-keygen -I） */
export const SIGNER_IDENTITY = 'release@ferretade.dev'
/** 公開鍵の正本（このリポジトリ。R2 の外） */
export const ALLOWED_SIGNERS_PATH = 'build/release-signing/allowed_signers'
/** 手元で公開するときの秘密鍵の置き場（リポジトリの外。Developer ID の ~/.ferret-signing/env と同じフォルダ） */
export const LOCAL_KEY_PATH = join(homedir(), '.ferret-signing', 'release-signing-key.pem')

const root = resolve(import.meta.dirname, '..')

/* ── SSH の形（RFC 4251 の string と uint32） ─────────────────────── */

function sshString(data) {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  return Buffer.concat([len, body])
}

function reader(buf) {
  let at = 0
  return {
    string() {
      if (at + 4 > buf.length) throw new Error('署名の形が正しくありません')
      const len = buf.readUInt32BE(at)
      if (at + 4 + len > buf.length) throw new Error('署名の形が正しくありません')
      const out = buf.subarray(at + 4, at + 4 + len)
      at += 4 + len
      return out
    },
    uint32() {
      if (at + 4 > buf.length) throw new Error('署名の形が正しくありません')
      const v = buf.readUInt32BE(at)
      at += 4
      return v
    },
    raw(n) {
      if (at + n > buf.length) throw new Error('署名の形が正しくありません')
      const out = buf.subarray(at, at + n)
      at += n
      return out
    },
    done: () => at === buf.length
  }
}

/** Ed25519 の公開鍵（KeyObject）→ SSH の公開鍵の塊（"ssh-ed25519" + 32 バイト） */
function publicKeyBlob(publicKey) {
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  return Buffer.concat([sshString('ssh-ed25519'), sshString(raw)])
}

/** "ssh-ed25519 AAAA…" → KeyObject（Ed25519 以外は断る） */
export function parseSshEd25519PublicKey(line) {
  const [type, b64] = line.trim().split(/\s+/)
  if (type !== 'ssh-ed25519' || !b64) throw new Error('ssh-ed25519 の公開鍵ではありません')
  const r = reader(Buffer.from(b64, 'base64'))
  if (r.string().toString() !== 'ssh-ed25519') throw new Error('ssh-ed25519 の公開鍵ではありません')
  const raw = r.string()
  if (raw.length !== 32 || !r.done()) throw new Error('ssh-ed25519 の公開鍵の長さが違います')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

export function sshPublicKeyLine(publicKey) {
  return `ssh-ed25519 ${publicKeyBlob(publicKey).toString('base64')}`
}

/** SSHSIG で署名する中身（PROTOCOL.sshsig の「signed data」）。ハッシュは sha512 */
function signedData(message, namespace) {
  const digest = createHash('sha512').update(message).digest()
  return Buffer.concat([Buffer.from('SSHSIG'), sshString(namespace), sshString(''), sshString('sha512'), sshString(digest)])
}

/** SHA256SUMS の中身に署名し、ssh-keygen -Y sign と同じ形（-----BEGIN SSH SIGNATURE-----）で返す */
export function signSshsig(message, privateKeyPem, namespace = SIGNING_NAMESPACE) {
  const privateKey = createPrivateKey(privateKeyPem)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('署名の鍵は Ed25519 にしてください')
  const publicKey = createPublicKey(privateKey)
  const sig = edSign(null, signedData(message, namespace), privateKey)
  const blob = Buffer.concat([
    Buffer.from('SSHSIG'),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicKeyBlob(publicKey)),
    sshString(namespace),
    sshString(''),
    sshString('sha512'),
    sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(sig)]))
  ])
  const lines = blob.toString('base64').match(/.{1,70}/g) ?? []
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join('\n')}\n-----END SSH SIGNATURE-----\n`
}

/**
 * SSHSIG の署名を確かめる。鍵・用途・ハッシュの種類まで合わなければ false（形が壊れていても false。例外は投げない）
 * @param publicKeyLine 信じる公開鍵（"ssh-ed25519 AAAA…"）。署名の中の鍵は信じず、これと同じかを比べる
 */
export function verifySshsig(message, armored, publicKeyLine, namespace = SIGNING_NAMESPACE) {
  try {
    const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(String(armored))
    if (!m) return false
    const r = reader(Buffer.from(m[1].replace(/\s+/g, ''), 'base64'))
    if (r.raw(6).toString() !== 'SSHSIG' || r.uint32() !== 1) return false
    const embeddedKey = r.string()
    const ns = r.string().toString()
    r.string() // reserved
    const hash = r.string().toString()
    const sigBlob = r.string()
    if (!r.done() || ns !== namespace || hash !== 'sha512') return false
    const trusted = parseSshEd25519PublicKey(publicKeyLine)
    if (!publicKeyBlob(trusted).equals(embeddedKey)) return false
    const s = reader(sigBlob)
    if (s.string().toString() !== 'ssh-ed25519') return false
    const sig = s.string()
    if (sig.length !== 64 || !s.done()) return false
    return edVerify(null, signedData(message, namespace), trusted, sig)
  } catch {
    return false
  }
}

/** allowed_signers（"<名前> ssh-ed25519 AAAA…"）から、署名者の公開鍵の行を取り出す */
export function trustedPublicKey(allowedSigners, identity = SIGNER_IDENTITY) {
  for (const line of allowedSigners.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const [principal, type, b64] = t.split(/\s+/)
    if (principal === identity && type === 'ssh-ed25519' && b64) return `${type} ${b64}`
  }
  throw new Error(`${ALLOWED_SIGNERS_PATH} に ${identity} の ssh-ed25519 の鍵がありません`)
}

/** リポジトリに固定した公開鍵で SHA256SUMS の署名を確かめる。合わなければ例外（公開を止めるため） */
export function assertSignedSums(sumsBytes, armored) {
  const key = trustedPublicKey(readFileSync(join(root, ALLOWED_SIGNERS_PATH), 'utf8'))
  if (!verifySshsig(sumsBytes, armored, key)) {
    throw new Error('SHA256SUMS の署名が、リポジトリの公開鍵（build/release-signing/allowed_signers）と合いません。公開を止めました')
  }
}

/* ── CLI ─────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { command: argv[0] }
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[++i]
    if (value === undefined) throw new Error(`${key} の値がありません`)
    if (key === '--out') args.out = value
    else if (key === '--sums') args.sums = value
    else if (key === '--sig') args.sig = value
    else if (key === '--key') args.key = value
    else throw new Error(`知らない引数です: ${key}`)
  }
  return args
}

/** 署名の鍵（環境変数 RELEASE_SIGNING_KEY の PEM、無ければ keyFile、無ければ手元の ~/.ferret-signing） */
export function loadSigningKey(keyFile) {
  if (process.env.RELEASE_SIGNING_KEY?.trim()) return process.env.RELEASE_SIGNING_KEY
  const file = keyFile ?? LOCAL_KEY_PATH
  if (!existsSync(file)) throw new Error(`署名の鍵がありません（環境変数 RELEASE_SIGNING_KEY か ${file}）`)
  return readFileSync(file, 'utf8')
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.command === 'keygen') {
    if (!args.out) throw new Error('--out <フォルダ> を指定してください')
    const dir = resolve(args.out)
    const keyFile = join(dir, 'release-signing-key.pem')
    if (existsSync(keyFile)) throw new Error(`${keyFile} はすでにあります（上書きしません）`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
    chmodSync(keyFile, 0o600)
    writeFileSync(join(dir, 'allowed_signers'), `${SIGNER_IDENTITY} ${sshPublicKeyLine(publicKey)}\n`, { flag: 'wx' })
    console.log(`秘密鍵: ${keyFile}（リポジトリ・R2 に置かない。GitHub の secret RELEASE_SIGNING_KEY に中身を入れる）`)
    console.log(`公開鍵: ${join(dir, 'allowed_signers')}（${ALLOWED_SIGNERS_PATH} と src/main/releaseSignature.ts に写す）`)
    return
  }
  if (args.command === 'sign') {
    if (!args.sums || !args.out) throw new Error('--sums と --out を指定してください')
    const sums = readFileSync(resolve(args.sums))
    const armored = signSshsig(sums, loadSigningKey(args.key))
    // 作った署名がリポジトリの公開鍵で確かめられることを、出す前に確かめる（鍵の取り違えに気づく）
    assertSignedSums(sums, armored)
    writeFileSync(resolve(args.out), armored)
    console.log(`署名しました: ${args.out}`)
    return
  }
  if (args.command === 'verify') {
    if (!args.sums || !args.sig) throw new Error('--sums と --sig を指定してください')
    assertSignedSums(readFileSync(resolve(args.sums)), readFileSync(resolve(args.sig), 'utf8'))
    console.log('署名を確かめました（リポジトリの公開鍵と一致）')
    return
  }
  throw new Error('使い方: release-signing.mjs keygen|sign|verify …（ファイルの先頭を参照）')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
