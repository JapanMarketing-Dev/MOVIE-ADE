import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { signSshsig, sshPublicKeyLine } from '../../scripts/release-signing.mjs'
import { RELEASE_PUBLIC_KEY as APP_KEY, RELEASE_SIGNING_NAMESPACE as APP_NS, MAX_INSTALLER_BYTES as APP_MAX } from '../../src/main/releaseSignature'
import { normalizeManifest } from '../../site/js/releases.js'
import {
  MAX_INSTALLER_BYTES,
  RELEASE_PUBLIC_KEY,
  RELEASE_SIGNING_NAMESPACE,
  fetchVerifiedBytes,
  verifiedAssets,
  verifyRelease,
  verifySshSignature
} from '../../site/js/verify.js'

/** security-4 [2]: サイトは署名で確かめたファイルだけを出し、保存する前に中身の SHA-256 を確かめる */

const BASE = 'https://downloads.example.com'
const key = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), line: sshPublicKeyLine(publicKey) }
})()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const BODY = 'installer bytes'

function release(version: string, files: Array<{ name: string; sha256: string; path?: string; size?: number }>) {
  return normalizeManifest({ schema: 1, version, files: files.map((f) => ({ path: `releases/${version}/${f.name}`, size: BODY.length, ...f })) }, BASE)!
}
function signedSums(lines: Array<[string, string]>) {
  const sums = Buffer.from(lines.map(([d, n]) => `${d}  ${n}\n`).join(''))
  return { sums: new Uint8Array(sums), sig: signSshsig(sums, key.pem) }
}

describe('site download verification (security-4 [2])', () => {
  it('uses the same release key and namespace as the app', () => {
    expect(RELEASE_PUBLIC_KEY).toBe(APP_KEY)
    expect(RELEASE_SIGNING_NAMESPACE).toBe(APP_NS)
    expect(MAX_INSTALLER_BYTES).toBe(APP_MAX)
  })

  it('verifies an SSHSIG made by the release tools, and rejects other keys or namespaces', async () => {
    const msg = Buffer.from('hello')
    expect(await verifySshSignature(new Uint8Array(msg), signSshsig(msg, key.pem), key.line)).toBe(true)
    expect(await verifySshSignature(new Uint8Array(msg), signSshsig(msg, key.pem, 'file'), key.line)).toBe(false)
    expect(await verifySshSignature(new Uint8Array(msg), signSshsig(msg, key.pem))).toBe(false)
    expect(await verifySshSignature(new Uint8Array(Buffer.from('hellp')), signSshsig(msg, key.pem), key.line)).toBe(false)
  })

  it('offers a file only when the manifest matches the signed SHA256SUMS exactly', async () => {
    const mac = 'Ferret-2.0.0-mac-arm64.dmg'
    const win = 'Ferret-2.0.0-win-x64.exe'
    const { sums, sig } = signedSums([[sha(BODY), mac], [sha('w'), win]])
    const ok = release('2.0.0', [{ name: mac, sha256: sha(BODY) }, { name: win, sha256: sha('w') }])
    const assets = await verifiedAssets(ok, BASE, sums, sig, key.line)
    expect(assets?.map((a: { url: string }) => a.url)).toEqual([`${BASE}/releases/2.0.0/${mac}`, `${BASE}/releases/2.0.0/${win}`])
    // 中身の値が違う・片方だけ・別の場所
    expect(await verifiedAssets(release('2.0.0', [{ name: mac, sha256: sha('x') }, { name: win, sha256: sha('w') }]), BASE, sums, sig, key.line)).toBeNull()
    expect(await verifiedAssets(release('2.0.0', [{ name: mac, sha256: sha(BODY) }]), BASE, sums, sig, key.line)).toBeNull()
    expect(await verifiedAssets(release('2.0.0', [{ name: mac, sha256: sha(BODY), path: 'evil/x.dmg' }, { name: win, sha256: sha('w') }]), BASE, sums, sig, key.line)).toBeNull()
    // 古い版の署名を新しい版として出す
    expect(await verifiedAssets(release('3.0.0', [{ name: mac, sha256: sha(BODY) }, { name: win, sha256: sha('w') }]), BASE, sums, sig, key.line)).toBeNull()
  })

  it('shows no links for a release whose signature is missing or does not match', async () => {
    const r = release('2.0.0', [{ name: 'Ferret-2.0.0-mac-arm64.dmg', sha256: sha(BODY) }])
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect(await verifyRelease(r, BASE, missing)).toMatchObject({ assets: [], verified: false })
    // サイトに同梱の鍵では、テストの鍵の署名は通らない
    const { sums, sig } = signedSums([[sha(BODY), 'Ferret-2.0.0-mac-arm64.dmg']])
    const forged = (async (url: string) => new Response(url.endsWith('.sig') ? sig : sums)) as unknown as typeof fetch
    expect(await verifyRelease(r, BASE, forged)).toMatchObject({ assets: [], verified: false })
  })

  it('saves bytes only when their SHA-256 matches the signed digest', async () => {
    const asset = { url: `${BASE}/releases/2.0.0/Ferret-2.0.0-mac-arm64.dmg`, size: BODY.length, sha256: sha(BODY) }
    const serve = (text: string) => (async () => new Response(text)) as unknown as typeof fetch
    const blob = await fetchVerifiedBytes(asset, undefined, serve(BODY))
    expect(await blob.text()).toBe(BODY)
    await expect(fetchVerifiedBytes(asset, undefined, serve('malicious bytes'))).rejects.toThrow()
    await expect(fetchVerifiedBytes(asset, undefined, serve(`${BODY}!`))).rejects.toThrow()
  })

  it('invariant: the site never puts an installer URL straight into a link', () => {
    const app = readFileSync(join(resolve(__dirname, '../..'), 'site/js/app.js'), 'utf8')
    expect(app).not.toMatch(/href\s*[:=]\s*(?:asset|f|file)\.url/)
    expect(app).toMatch(/verifyRelease\(/)
    expect(app).toMatch(/fetchVerifiedBytes\(/)
  })
})
