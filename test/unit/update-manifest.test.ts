import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '44.5.1' }, net: { fetch: vi.fn() } }))
const { DOWNLOAD_PAGE_URL, RELEASE_BASE_URL, judgeManifest, parseManifest, pickReleaseFile } = await import('../../src/main/updateCheck')

const file = (os: string, arch: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ name: `ADE-${os}-${arch}.${kind}`, path: `0.2.0/ADE-${os}-${arch}.${kind}`, size: 1, sha256: 'x', os, arch, kind, ...extra })

const MANIFEST = {
  schema: 1,
  version: '0.2.0',
  date: '2026-10-03T00:00:00Z',
  prerelease: false,
  notes: '- 修正',
  files: [
    file('mac', 'arm64', 'dmg'),
    file('mac', 'x64', 'dmg'),
    file('win', 'x64', 'exe'),
    file('linux', 'x64', 'deb'),
    file('linux', 'x64', 'AppImage'),
    file('linux', 'arm64', 'AppImage', { preview: true })
  ]
}

describe('parseManifest', () => {
  it('合意した形を読む', () => {
    const m = parseManifest(MANIFEST)
    expect(m?.version).toBe('0.2.0')
    expect(m?.files).toHaveLength(6)
  })
  it('schema が違う・壊れた JSON は null', () => {
    expect(parseManifest({ ...MANIFEST, schema: 2 })).toBeNull()
    expect(parseManifest(null)).toBeNull()
    expect(parseManifest({ schema: 1, version: '0.2.0' })).toBeNull()
  })
  it('OS・CPU が不明なファイルは除く', () => {
    expect(parseManifest({ ...MANIFEST, files: [{ ...file('mac', 'arm64', 'dmg'), os: 'bsd' }] })?.files).toEqual([])
  })
})

describe('pickReleaseFile', () => {
  const files = parseManifest(MANIFEST)!.files
  it('自分の OS・CPU に合うものを選ぶ', () => {
    expect(pickReleaseFile(files, 'darwin', 'arm64')?.kind).toBe('dmg')
    expect(pickReleaseFile(files, 'win32', 'x64')?.kind).toBe('exe')
  })
  it('Linux は AppImage を deb より先に勧める', () => {
    expect(pickReleaseFile(files, 'linux', 'x64')?.kind).toBe('AppImage')
  })
  it('合うものが無ければ null', () => {
    expect(pickReleaseFile(files, 'win32', 'arm64')).toBeNull()
    expect(pickReleaseFile(files, 'freebsd', 'x64')).toBeNull()
  })
})

describe('judgeManifest', () => {
  const m = parseManifest(MANIFEST)!
  it('新しければダウンロードサイトを開く先にする', () => {
    // ダウンロードサイトは ferretade.dev（旧ドメインも動くので、配布済みの版は影響なし）
    expect(DOWNLOAD_PAGE_URL).toBe('https://ferretade.dev/download')
    expect(judgeManifest('0.1.0', m, 'darwin', 'arm64')).toEqual({
      state: 'available', current: '0.1.0', latest: '0.2.0', url: DOWNLOAD_PAGE_URL
    })
  })
  it('ダウンロードサイトが空なら R2 上の自分向けファイルを開く', () => {
    expect(judgeManifest('0.1.0', m, 'darwin', 'arm64', '')).toEqual({
      state: 'available', current: '0.1.0', latest: '0.2.0', url: `${RELEASE_BASE_URL}0.2.0/ADE-mac-arm64.dmg`
    })
  })
  it('同じか古ければ最新', () => {
    expect(judgeManifest('0.2.0', m, 'darwin', 'arm64').state).toBe('latest')
    expect(judgeManifest('0.3.0', m, 'darwin', 'arm64').state).toBe('latest')
  })
  it('自分向けのファイルが無ければ配信元を開く', () => {
    const r = judgeManifest('0.1.0', m, 'win32', 'arm64', '')
    expect(r.state === 'available' && r.url).toBe(RELEASE_BASE_URL)
  })
  it('path が別サイトの絶対URLなら開かない', () => {
    const evil = parseManifest({ ...MANIFEST, files: [file('mac', 'arm64', 'dmg', { path: 'https://evil.example/x.dmg' })] })!
    const r = judgeManifest('0.1.0', evil, 'darwin', 'arm64', '')
    expect(r.state === 'available' && r.url).toBe(RELEASE_BASE_URL)
  })
  it('版番号が読めなければ失敗', () => {
    expect(judgeManifest('0.1.0', { ...m, version: 'latest' }).state).toBe('error')
  })
})
