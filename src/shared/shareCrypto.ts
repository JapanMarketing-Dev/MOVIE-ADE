/**
 * 共有リンクのパスワードとメモの暗号（Web Crypto だけを使う。ブラウザ・Cloudflare Worker・Electron の main で同じ処理）。
 *
 * - パスワードの確認: 相手のブラウザ（とアプリ）が PBKDF2-SHA256（authSalt）でパスワードから「証明」を作って送る。
 *   Worker は証明の SHA-256（verifier）だけを持ち、届いた証明の SHA-256 と比べる。パスワードそのものはサーバーへ届かない
 * - メモの暗号: パスワードから別のソルト（memo の salt）で PBKDF2-SHA256 の鍵を作り、AES-256-GCM で暗号化する。
 *   Worker には暗号文だけを置き、相手の画面が手元で復号する（パスワードの無い共有のメモは平文）
 * PBKDF2 の回数は Cloudflare Worker の上限（100,000 回）に合わせる。
 */

export const SHARE_KDF_ITERATIONS = 100_000
const SALT_BYTES = 16
const IV_BYTES = 12

/** 暗号化したメモ（base64 の値） */
export interface SealedMemo {
  v: 1
  iterations: number
  salt: string
  iv: string
  data: string
}

/** パスワードの確認に使う値（Worker が持つ）。verifier は証明の SHA-256（16 進） */
export interface ShareAuthVerifier {
  salt: string
  iterations: number
  verifier: string
}

/** ブラウザ・Worker・Node のどれでも同じ型（DOM の型に頼らない。main の型検査は DOM を持たない） */
type Subtle = typeof globalThis.crypto.subtle
type Key = Awaited<ReturnType<Subtle['importKey']>>
const subtle = (): Subtle => globalThis.crypto.subtle

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', new TextEncoder().encode(text))))
}

async function passwordKey(password: string): Promise<Key> {
  return subtle().importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits', 'deriveKey'])
}

/** パスワードの「証明」（16 進）。ソルトと回数は共有ごとに Worker が返す */
export async function passwordProof(password: string, salt: string, iterations = SHARE_KDF_ITERATIONS): Promise<string> {
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations }, await passwordKey(password), 256)
  return toHex(new Uint8Array(bits))
}

/** 共有を作るとき（アプリ）: 新しいソルトで証明を作り、その SHA-256 を Worker に渡す */
export async function makeAuthVerifier(password: string): Promise<ShareAuthVerifier> {
  const salt = toBase64(randomBytes(SALT_BYTES))
  const proof = await passwordProof(password, salt)
  return { salt, iterations: SHARE_KDF_ITERATIONS, verifier: await sha256Hex(proof) }
}

async function memoKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Key> {
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, await passwordKey(password), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** メモを暗号化する（毎回新しいソルトと IV） */
export async function sealMemo(password: string, text: string): Promise<SealedMemo> {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await memoKey(password, salt, SHARE_KDF_ITERATIONS)
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)))
  return { v: 1, iterations: SHARE_KDF_ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) }
}

/** メモを復号する。パスワードが違う・壊れていれば null */
export async function openMemo(password: string, sealed: SealedMemo): Promise<string | null> {
  try {
    const key = await memoKey(password, fromBase64(sealed.salt), sealed.iterations)
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data))
    return new TextDecoder('utf-8', { fatal: true }).decode(plain)
  } catch {
    return null
  }
}

/** 暗号化したメモの形を確かめる（Worker が受け取るとき） */
export function isSealedMemo(raw: unknown, maxDataChars: number): raw is SealedMemo {
  if (!raw || typeof raw !== 'object') return false
  const m = raw as Record<string, unknown>
  const b64 = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(v)
  return m.v === 1 && m.iterations === SHARE_KDF_ITERATIONS && b64(m.salt, 64) && b64(m.iv, 64) && b64(m.data, maxDataChars)
}

/** 共有のパスワードを作る（読み違えにくい文字だけ、16 字） */
export function generateSharePassword(length = 16): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const out: string[] = []
  // 偏りが出ないよう、alphabet の長さの倍数に収まる値だけを使う
  const limit = 256 - (256 % alphabet.length)
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit && out.length < length) out.push(alphabet[b % alphabet.length]!)
    }
  }
  return out.join('')
}
