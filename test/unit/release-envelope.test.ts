import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signSshsig, sshPublicKeyLine } from '../../scripts/release-signing.mjs'
import { setReporter } from '../../src/shared/report'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1' }, net: { fetch: vi.fn() } }))
const { verifiedReleaseFiles, parseSignedArtifactName } = await import('../../src/main/releaseSignature')
const { RELEASE_BASE_URL, pickVerifiedDownload } = await import('../../src/main/updateCheck')
const { downloadVerifiedUpdate, UpdateDownloadError } = await import('../../src/main/updateDownload')

/**
 * security-4 [3]: 署名した SHA256SUMS の名前（版・OS・CPU・種類を含む）から身元と置き場所を作り、manifest の値は使わない。
 * security-4 [7]: 確かめた版・名前・sha256 のまま、アプリが落として中身を確かめる。
 */

const key = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), line: sshPublicKeyLine(publicKey) }
})()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const signed = (lines: Array<[string, string]>) => {
  const sums = Buffer.from(lines.map(([digest, name]) => `${digest}  ${name}\n`).join(''))
  return { sums, sig: signSshsig(sums, key.pem) }
}
const entry = (version: string, name: string, digest: string, extra: Record<string, unknown> = {}) =>
  ({ name, sha256: digest, path: `releases/${version}/${name}`, size: 10, ...extra })

describe('signed release envelope (security-4 [3])', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  it('rejects an older signed SHA256SUMS replayed under a newer version', () => {
    const { sums, sig } = signed([[A, 'Ferret-1.0.0-mac-arm64.dmg']])
    // 1.0.0 の署名を 9.0.0 として出す（R2 の releases/9.0.0/ に置き直しただけ）
    expect(verifiedReleaseFiles('9.0.0', [entry('9.0.0', 'Ferret-1.0.0-mac-arm64.dmg', A)], sums, sig, key.line)).toBeNull()
    expect(verifiedReleaseFiles('1.0.0', [entry('1.0.0', 'Ferret-1.0.0-mac-arm64.dmg', A)], sums, sig, key.line)).toHaveLength(1)
  })

  it('rejects any unsigned path, product or file-set change', () => {
    const { sums, sig } = signed([[A, 'Ferret-2.0.0-mac-arm64.dmg'], [B, 'Ferret-2.0.0-win-x64.exe']])
    const ok = [entry('2.0.0', 'Ferret-2.0.0-mac-arm64.dmg', A), entry('2.0.0', 'Ferret-2.0.0-win-x64.exe', B)]
    expect(verifiedReleaseFiles('2.0.0', ok, sums, sig, key.line)).toHaveLength(2)
    // 片方だけ（集まりが違う）
    expect(verifiedReleaseFiles('2.0.0', ok.slice(0, 1), sums, sig, key.line)).toBeNull()
    // 別の置き場所・別のサイト
    for (const path of ['releases/2.0.0/evil.dmg', 'releases/1.0.0/Ferret-2.0.0-mac-arm64.dmg', 'https://evil.example/Ferret-2.0.0-mac-arm64.dmg', 'releases/2.0.0/../x/Ferret-2.0.0-mac-arm64.dmg']) {
      expect(verifiedReleaseFiles('2.0.0', [{ ...ok[0]!, path }, ok[1]!], sums, sig, key.line)).toBeNull()
    }
    // 作り直しのフォルダ（b2）は通す
    expect(verifiedReleaseFiles('2.0.0', [{ ...ok[0]!, path: 'releases/2.0.0/b2/Ferret-2.0.0-mac-arm64.dmg' }, ok[1]!], sums, sig, key.line)).toHaveLength(2)
    // 別の製品の名前は署名されていても読まない
    const other = signed([[A, 'Other-2.0.0-mac-arm64.dmg']])
    expect(verifiedReleaseFiles('2.0.0', [entry('2.0.0', 'Other-2.0.0-mac-arm64.dmg', A)], other.sums, other.sig, key.line)).toBeNull()
  })

  it('takes the platform from the signed name, not from manifest fields', () => {
    const { sums, sig } = signed([[A, 'Ferret-3.0.0-win-x64.exe']])
    // manifest が mac と偽っても、署名した名前の win として扱う
    const files = verifiedReleaseFiles('3.0.0', [entry('3.0.0', 'Ferret-3.0.0-win-x64.exe', A, { os: 'mac', arch: 'arm64', kind: 'dmg' })], sums, sig, key.line)!
    expect(files[0]).toMatchObject({ os: 'win', arch: 'x64', kind: 'exe' })
    expect(pickVerifiedDownload('3.0.0', files, 'darwin', 'arm64')).toBeNull()
    expect(pickVerifiedDownload('3.0.0', files, 'win32', 'x64')).toEqual({
      version: '3.0.0', name: 'Ferret-3.0.0-win-x64.exe', sha256: A, size: 10, kind: 'exe', url: `${RELEASE_BASE_URL}releases/3.0.0/Ferret-3.0.0-win-x64.exe`
    })
  })

  it('reads the names the release tools produce', () => {
    expect(parseSignedArtifactName('Ferret-0.4.0-linux-x86_64.AppImage', '0.4.0')).toEqual({ os: 'linux', arch: 'x64', kind: 'AppImage' })
    expect(parseSignedArtifactName('Ferret-0.4.0-linux-amd64.deb', '0.4.0')).toEqual({ os: 'linux', arch: 'x64', kind: 'deb' })
    expect(parseSignedArtifactName('Ferret-0.4.0-mac-arm64.dmg', '0.4.1')).toBeNull()
  })
})

describe('verified update download (security-4 [7])', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-dl-'))
    setReporter({ handled: vi.fn(), message: vi.fn(), breadcrumb: vi.fn() })
  })
  afterEach(() => {
    setReporter(null)
    rmSync(dir, { recursive: true, force: true })
  })
  const body = 'installer bytes'
  const file = { version: '3.0.0', name: 'Ferret-3.0.0-mac-arm64.dmg', sha256: sha(body), size: body.length, kind: 'dmg' as const, url: `${RELEASE_BASE_URL}releases/3.0.0/Ferret-3.0.0-mac-arm64.dmg` }
  const serve = (text: string) => (async () => new Response(text)) as unknown as typeof fetch

  it('saves the file only when its bytes match the signed digest', async () => {
    const saved = await downloadVerifiedUpdate(file, dir, serve(body))
    expect(readFileSync(saved, 'utf8')).toBe(body)
    expect(readdirSync(dir)).toEqual(['Ferret-3.0.0-mac-arm64.dmg'])
    // 2回目は上書きせずに名前をずらす
    expect(await downloadVerifiedUpdate(file, dir, serve(body))).toBe(join(dir, 'Ferret-3.0.0-mac-arm64 (1).dmg'))
  })

  it('refuses bytes that R2 replaced after the check, and leaves nothing behind', async () => {
    const swapped = 'malicious bytes'
    await expect(downloadVerifiedUpdate(file, dir, serve(swapped))).rejects.toBeInstanceOf(UpdateDownloadError)
    await expect(downloadVerifiedUpdate(file, dir, serve(`${body}!`))).rejects.toBeInstanceOf(UpdateDownloadError)
    expect(readdirSync(dir)).toEqual([])
  })

  it('checkForUpdate keeps the verified file for this machine; the download uses it, not a refetched page', async () => {
    const { checkForUpdate, verifiedDownload } = await import('../../src/main/updateCheck')
    const name = `Ferret-99.0.0-${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}.${process.platform === 'darwin' ? 'dmg' : process.platform === 'win32' ? 'exe' : 'AppImage'}`
    const { sums, sig } = signed([[sha(body), name]])
    const fetcher = (async (url: string) => {
      if (url.endsWith('latest.json')) return Response.json({ schema: 1, version: '99.0.0', date: '', prerelease: false, notes: '', files: [entry('99.0.0', name, sha(body), { size: body.length, os: 'mac', arch: 'arm64', kind: 'dmg' })] })
      if (url.endsWith('/SHA256SUMS')) return new Response(sums)
      if (url.endsWith('/SHA256SUMS.sig')) return new Response(sig)
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch
    const { RELEASE_PUBLIC_KEY } = await import('../../src/main/releaseSignature')
    // 同梱の公開鍵では、テストの鍵の署名は通らない（偽の版を案内しない）
    expect(RELEASE_PUBLIC_KEY).not.toBe(key.line)
    expect((await checkForUpdate(fetcher)).state).toBe('unverified')
    expect(verifiedDownload()).toBeNull()
  })
})
