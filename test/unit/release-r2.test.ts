import { describe, expect, it } from 'vitest'
import {
  addVersionToIndex,
  buildManifest,
  compareVersionsDesc,
  emptyIndex,
  obsoleteFiles,
  parseArtifactName,
  replaceVersionInIndex,
  type ReleaseManifest
} from '../../scripts/release-r2-lib.mjs'

function manifest(version: string, prerelease = false): ReleaseManifest {
  return buildManifest({ version, date: '2026-10-03T00:00:00Z', prerelease, notes: '', files: [] })
}

describe('R2 へのリリース（索引と manifest）', () => {
  it('合意したファイル名だけを拾い、OS と CPU を読む', () => {
    expect(parseArtifactName('MOVIE-ADE-0.1.0-mac-arm64.dmg', '0.1.0')).toEqual({ name: 'MOVIE-ADE-0.1.0-mac-arm64.dmg', os: 'mac', arch: 'arm64', kind: 'dmg' })
    expect(parseArtifactName('MOVIE-ADE-0.1.0-win-x64.exe', '0.1.0')?.arch).toBe('x64')
    expect(parseArtifactName('MOVIE-ADE-0.1.0-linux-x86_64.AppImage', '0.1.0')?.arch).toBe('x64')
    expect(parseArtifactName('MOVIE-ADE-0.1.0-linux-amd64.deb', '0.1.0')).toMatchObject({ os: 'linux', arch: 'x64', kind: 'deb' })
    expect(parseArtifactName('MOVIE-ADE-0.1.0-win-x64.exe.blockmap', '0.1.0')).toBeNull()
    expect(parseArtifactName('latest-mac.yml', '0.1.0')).toBeNull()
    // 別の版のファイルは混ぜない
    expect(parseArtifactName('MOVIE-ADE-0.1.1-mac-arm64.dmg', '0.1.0')).toBeNull()
  })

  it('manifest は path をバケット直下からの相対にし、Preview の OS に印を付ける', () => {
    const m = buildManifest({
      version: '0.1.0', date: '2026-10-03T00:00:00Z', prerelease: false, notes: 'n', previewOs: ['win', 'linux'],
      files: [
        { name: 'MOVIE-ADE-0.1.0-linux-amd64.deb', os: 'linux', arch: 'x64', kind: 'deb', size: 3, sha256: 'c' },
        { name: 'MOVIE-ADE-0.1.0-mac-arm64.dmg', os: 'mac', arch: 'arm64', kind: 'dmg', size: 1, sha256: 'a' }
      ]
    })
    expect(m.files.map((f) => f.name)).toEqual(['MOVIE-ADE-0.1.0-mac-arm64.dmg', 'MOVIE-ADE-0.1.0-linux-amd64.deb'])
    expect(m.files[0]).toEqual({ name: 'MOVIE-ADE-0.1.0-mac-arm64.dmg', path: 'releases/0.1.0/MOVIE-ADE-0.1.0-mac-arm64.dmg', size: 1, sha256: 'a', os: 'mac', arch: 'arm64', kind: 'dmg' })
    expect(m.files[1]!.preview).toBe(true)
  })

  it('版は数字として比べる', () => {
    expect(['0.9.0', '0.10.0', '0.10.0-beta.1', '1.0.0'].sort(compareVersionsDesc)).toEqual(['1.0.0', '0.10.0', '0.10.0-beta.1', '0.9.0'])
  })

  it('同じ版は二重に足さない', () => {
    const { index } = addVersionToIndex(emptyIndex(), manifest('0.1.0'))
    expect(index.latest).toBe('0.1.0')
    expect(() => addVersionToIndex(index, manifest('0.1.0'))).toThrow(/すでに/)
  })

  it('10版を超えたら古い版を外し、latest は最新の正式版', () => {
    let index = emptyIndex()
    for (let i = 1; i <= 10; i++) index = addVersionToIndex(index, manifest(`0.${i}.0`)).index
    const next = addVersionToIndex(index, manifest('0.11.0-beta.1', true))
    expect(next.index.versions).toHaveLength(10)
    expect(next.index.versions[0]!.version).toBe('0.11.0-beta.1')
    expect(next.index.latest).toBe('0.10.0')
    expect(next.removed).toEqual([{ version: '0.1.0', manifest: 'releases/0.1.0/manifest.json' }])
  })

  it('作り直した版（--replace）は b<build>/ に置き、ファイル名は変えない', () => {
    const files = [{ name: 'MOVIE-ADE-0.1.0-mac-arm64.dmg', os: 'mac' as const, arch: 'arm64', kind: 'dmg', size: 1, sha256: 'a' }]
    const first = buildManifest({ version: '0.1.0', date: 'd1', prerelease: false, notes: '', files })
    const second = buildManifest({ version: '0.1.0', date: 'd2', prerelease: false, notes: '', files, build: 2 })
    expect(first.files[0]!.path).toBe('releases/0.1.0/MOVIE-ADE-0.1.0-mac-arm64.dmg')
    expect(first.build).toBeUndefined()
    expect(second.build).toBe(2)
    expect(second.files[0]!.path).toBe('releases/0.1.0/b2/MOVIE-ADE-0.1.0-mac-arm64.dmg')
    expect(second.files[0]!.name).toBe(first.files[0]!.name)
    expect(obsoleteFiles(first, second)).toEqual(['releases/0.1.0/MOVIE-ADE-0.1.0-mac-arm64.dmg'])
  })

  it('差し替えは版の位置と数を変えず、日付とファイル数を新しくする', () => {
    let index = emptyIndex()
    index = addVersionToIndex(index, manifest('0.1.0')).index
    index = addVersionToIndex(index, manifest('0.2.0')).index
    const replaced = replaceVersionInIndex(index, { ...manifest('0.1.0'), date: '2026-10-04T00:00:00Z', build: 2 })
    expect(replaced.versions.map((v) => v.version)).toEqual(['0.2.0', '0.1.0'])
    expect(replaced.versions[1]!.date).toBe('2026-10-04T00:00:00Z')
    expect(replaced.latest).toBe('0.2.0')
    expect(() => replaceVersionInIndex(index, manifest('0.3.0'))).toThrow(/公開されていない/)
  })
})
