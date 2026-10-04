// ダウンロードの真正性（security-4 [2]）。
//
// 索引・manifest・インストーラーは同じ R2 に置くので、R2 を書き換えられると全部を差し替えられる。
// このサイト（R2 とは別の場所から配る）に同梱した公開鍵で releases/<版>/SHA256SUMS の署名を確かめ、
//   1. manifest のファイルが署名した SHA256SUMS と過不足なく同じ（名前と sha256）
//   2. 名前はその版の配布物の名前（Ferret-<版>-<os>-<arch>.<ext>）。置き場所は releases/<版>/<名前> だけ
// のときだけリンクを出す。クリックすると中身を取り、SHA-256 が署名の値と同じときだけ保存する。
// 署名の形は OpenSSH の SSHSIG。アプリ（src/main/releaseSignature.ts）と同じ鍵・用途（単体テストで突き合わせる）。

/** 信じる公開鍵（build/release-signing/allowed_signers・src/main/releaseSignature.ts と同じ） */
export const RELEASE_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpXERU8ST0MEOIMbzoL4zShkjIrMB4++NL3xBohKAS9'
export const RELEASE_SIGNING_NAMESPACE = 'ferret-release'
/** 製品名（配布物の名前の先頭） */
export const RELEASE_PRODUCT = 'Ferret'
/** SHA256SUMS と署名の上限 */
const SIGNED_SUMS_MAX_BYTES = 64 * 1024
/** インストーラーの大きさの上限（アプリの MAX_INSTALLER_BYTES と同じ） */
export const MAX_INSTALLER_BYTES = 400 * 1024 * 1024

const ARCH_OF = { arm64: 'arm64', aarch64: 'arm64', x64: 'x64', x86_64: 'x64', amd64: 'x64' }

const enc = new TextEncoder()

function base64ToBytes(text) {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function sshString(data) {
  const body = typeof data === 'string' ? enc.encode(data) : data
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, body.length)
  return concat([len, body])
}

function reader(buf) {
  let at = 0
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const need = (n) => {
    if (at + n > buf.length) throw new Error('truncated')
  }
  return {
    uint32() {
      need(4)
      const v = view.getUint32(at)
      at += 4
      return v
    },
    raw(n) {
      need(n)
      const out = buf.subarray(at, at + n)
      at += n
      return out
    },
    string() {
      return this.raw(this.uint32())
    },
    done: () => at === buf.length,
  }
}

const text = (bytes) => new TextDecoder().decode(bytes)
const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * SSHSIG の署名を確かめる。鍵・用途・ハッシュの種類まで合わなければ false（壊れた入力でも例外を投げない）。
 * Ed25519 に対応しないブラウザでも false（リンクを出さない）
 * @param {Uint8Array} message
 * @param {string} armored
 */
export async function verifySshSignature(message, armored, trustedKey = RELEASE_PUBLIC_KEY, namespace = RELEASE_SIGNING_NAMESPACE) {
  try {
    const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(String(armored))
    if (!m) return false
    const r = reader(base64ToBytes(m[1].replace(/\s+/g, '')))
    if (text(r.raw(6)) !== 'SSHSIG' || r.uint32() !== 1) return false
    const embedded = r.string()
    const ns = text(r.string())
    r.string() // reserved
    const hash = text(r.string())
    const sigBlob = r.string()
    if (!r.done() || ns !== namespace || hash !== 'sha512') return false
    const [type, b64] = trustedKey.trim().split(/\s+/)
    if (type !== 'ssh-ed25519' || !b64) return false
    const trustedBlob = base64ToBytes(b64)
    if (!equalBytes(trustedBlob, embedded)) return false
    const k = reader(trustedBlob)
    if (text(k.string()) !== 'ssh-ed25519') return false
    const raw = k.string()
    if (raw.length !== 32 || !k.done()) return false
    const s = reader(sigBlob)
    if (text(s.string()) !== 'ssh-ed25519') return false
    const sig = s.string()
    if (sig.length !== 64 || !s.done()) return false
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', message))
    const signed = concat([enc.encode('SSHSIG'), sshString(namespace), sshString(''), sshString('sha512'), sshString(digest)])
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, signed)
  } catch {
    return false
  }
}

/** SHA256SUMS → 名前 → sha256。読めない行・同じ名前があれば null */
export function parseSignedSums(sumsText) {
  const sums = new Map()
  for (const line of sumsText.split('\n')) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line.trimEnd())
    if (!m || sums.has(m[2])) return null
    sums.set(m[2], m[1])
  }
  return sums.size > 0 ? sums : null
}

/** 配布物の名前を、決まった版として読む。別の版・別の製品・別の形は null */
export function parseSignedArtifactName(name, version) {
  const escaped = version.replace(/[.+]/g, (c) => `\\${c}`)
  const m = new RegExp(`^${RELEASE_PRODUCT}-${escaped}-(mac|win|linux)-([A-Za-z0-9_]+)\\.(dmg|exe|AppImage|deb)$`).exec(name)
  const arch = m ? ARCH_OF[m[2]] : undefined
  if (!m || !arch) return null
  return { os: m[1], arch, kind: m[3] }
}

/**
 * 表示用の版（releases.js の normalizeManifest の結果）の assets を、署名した SHA256SUMS と突き合わせる。
 * すべて合えば、名前から OS・CPU・種類を読み、URL を releases/<版>/<名前> から作った assets を返す。1つでも合わなければ null
 * @param {{ version: string, assets: Array<{ name: string, url: string, size: number, sha256: string, preview: boolean }> }} release
 * @param {string} base 配信元（config.js の DOWNLOAD_BASE）
 * @param {Uint8Array} sums
 * @param {string} signature
 */
export async function verifiedAssets(release, base, sums, signature, trustedKey = RELEASE_PUBLIC_KEY) {
  if (!(await verifySshSignature(sums, signature, trustedKey))) return null
  const table = parseSignedSums(new TextDecoder().decode(sums))
  const { version, assets } = release
  if (!table || assets.length === 0 || table.size !== assets.length) return null
  for (const name of table.keys()) if (!parseSignedArtifactName(name, version)) return null
  const root = `${base.replace(/\/+$/, '')}/releases/${version}/`
  const out = []
  const seen = new Set()
  for (const a of assets) {
    const info = parseSignedArtifactName(a.name, version)
    if (!info || seen.has(a.name) || table.get(a.name) !== a.sha256) return null
    seen.add(a.name)
    // 作り直し（releases/<版>/b<n>/）だけは置き場所が変わる。それ以外の URL は使わない
    const rest = a.url.startsWith(root) ? a.url.slice(root.length) : null
    if (rest !== a.name && !(rest !== null && /^b\d{1,3}\//.test(rest) && rest.slice(rest.indexOf('/') + 1) === a.name)) return null
    if (!Number.isInteger(a.size) || a.size <= 0 || a.size > MAX_INSTALLER_BYTES) return null
    out.push({ ...a, info })
  }
  return out
}

async function readCapped(res, max) {
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length > max) throw new Error('too large')
  return buf
}

/**
 * releases/<版>/SHA256SUMS(.sig) を取り、署名で確かめた版にする。
 * 署名が無い・合わない版は assets を空にし、verified: false を付ける（リンクを出さない）。通信の失敗は例外
 * @param {any} release normalizeManifest の結果
 * @param {string} base
 * @param {typeof fetch} fetcher
 */
export async function verifyRelease(release, base, fetcher = fetch) {
  const dir = `${base.replace(/\/+$/, '')}/releases/${encodeURIComponent(release.version)}/`
  const [sumsRes, sigRes] = await Promise.all([fetcher(`${dir}SHA256SUMS`, { cache: 'no-cache' }), fetcher(`${dir}SHA256SUMS.sig`, { cache: 'no-cache' })])
  if (sumsRes.status >= 500 || sigRes.status >= 500) throw new Error(`HTTP ${Math.max(sumsRes.status, sigRes.status)}`)
  const assets = sumsRes.ok && sigRes.ok
    ? await verifiedAssets(release, base, await readCapped(sumsRes, SIGNED_SUMS_MAX_BYTES), new TextDecoder().decode(await readCapped(sigRes, SIGNED_SUMS_MAX_BYTES)))
    : null
  return assets ? { ...release, assets, verified: true } : { ...release, assets: [], verified: false }
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 確かめたファイルを取り、大きさと SHA-256 が署名の値と同じときだけ Blob を返す。違えば例外
 * @param {{ url: string, size: number, sha256: string }} asset verifiedAssets の結果
 * @param {(fraction: number) => void} [onProgress]
 * @param {typeof fetch} [fetcher]
 */
export async function fetchVerifiedBytes(asset, onProgress, fetcher = fetch) {
  const res = await fetcher(asset.url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const bytes = new Uint8Array(asset.size)
  let at = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (at + value.length > asset.size) {
      await reader.cancel().catch(() => undefined)
      throw new Error('size mismatch')
    }
    bytes.set(value, at)
    at += value.length
    onProgress?.(at / asset.size)
  }
  if (at !== asset.size) throw new Error('size mismatch')
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== asset.sha256) throw new Error('digest mismatch')
  return new Blob([bytes], { type: 'application/octet-stream' })
}
