import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertManifestMatchesSums,
  assertValidVersion,
  buildManifest,
  formatSha256Sums,
  ghReleaseCreateArgs,
  ghReleaseNotes,
  ghReleasePublishArgs,
  isExactPackageSpec,
  parseSha256Sums,
  validateIndex,
  validateManifest,
  workPath
} from '../../scripts/release-r2-lib.mjs'
import { runTool } from '../../scripts/release-tools.mjs'

/**
 * R2 から読んだ manifest・索引を信用しない（セキュリティ報告 [1] [6]）。
 * R2 の中身はトークンが漏れれば書き換えられるので、promote / discard は形を確かめてから使い、
 * 外から来た値が shell に解釈されたり、作業フォルダの外のパスになったりしないことを確かめる。
 * 本物の R2・wrangler は動かさない（純粋関数と、node 自身を子プロセスに使う確認だけ）。
 */

const SHA = 'a'.repeat(64)
const SHA2 = 'b'.repeat(64)

function good(build = 1) {
  return buildManifest({
    version: '0.3.0',
    date: '2026-10-03T00:00:00Z',
    prerelease: false,
    notes: 'Ferret 0.3.0',
    notesUrl: 'https://github.com/JapanMarketing-Dev/ferret/releases/tag/v0.3.0',
    files: [
      { name: 'Ferret-0.3.0-mac-arm64.dmg', os: 'mac', arch: 'arm64', kind: 'dmg', size: 100, sha256: SHA },
      { name: 'Ferret-0.3.0-win-x64.exe', os: 'win', arch: 'x64', kind: 'exe', size: 200, sha256: SHA2 }
    ],
    product: 'Ferret',
    build
  })
}

/** 1つ目のファイルを書き換えた manifest */
function withFile(patch: Record<string, unknown>) {
  const m = good() as unknown as { files: Record<string, unknown>[] }
  m.files[0] = { ...m.files[0], ...patch }
  return m
}

const HOSTILE = ['../escape', '..\\escape', 'a & calc.exe', 'a | rm -rf ~', 'a"b', "a'b", '$(touch pwned)', '`touch pwned`', '/etc/passwd', 'C:\\Windows\\x.exe', 'Ferret-0.3.0-mac-arm64.dmg\n& calc']

describe('validateManifest: R2 の manifest を厳しく確かめる', () => {
  it('stage が作った manifest（build 1 と差し替えの build 2）は通る', () => {
    expect(validateManifest(good(), '0.3.0').files).toHaveLength(2)
    expect(validateManifest(good(2), '0.3.0').files[0].path).toBe('releases/0.3.0/b2/Ferret-0.3.0-mac-arm64.dmg')
  })

  it.each(HOSTILE)('name に %j が入っていたら止める（ローカルのパスにも引数にもしない）', (name) => {
    expect(() => validateManifest(withFile({ name }), '0.3.0')).toThrow()
  })

  it.each(HOSTILE.map((h) => `releases/0.3.0/${h}`).concat(['releases/0.2.0/Ferret-0.3.0-mac-arm64.dmg', 'versions.json', 'releases/0.3.0/../../versions.json']))(
    'path が %j なら止める（その版のフォルダの外の R2 のキーに触らない）',
    (p) => {
      expect(() => validateManifest(withFile({ path: p }), '0.3.0')).toThrow()
    }
  )

  it('sha256・size・os・kind・version・schema の形が違えば止める', () => {
    expect(() => validateManifest(withFile({ sha256: 'xyz' }), '0.3.0')).toThrow()
    expect(() => validateManifest(withFile({ sha256: SHA.toUpperCase() }), '0.3.0')).toThrow()
    expect(() => validateManifest(withFile({ size: -1 }), '0.3.0')).toThrow()
    expect(() => validateManifest(withFile({ size: 400 * 1024 * 1024 }), '0.3.0')).toThrow()
    expect(() => validateManifest(withFile({ os: 'win' }), '0.3.0')).toThrow()
    expect(() => validateManifest(withFile({ kind: 'exe' }), '0.3.0')).toThrow()
    expect(() => validateManifest(good(), '0.3.1')).toThrow()
    expect(() => validateManifest({ ...good(), schema: 2 }, '0.3.0')).toThrow()
    expect(() => validateManifest({ ...good(), files: [] }, '0.3.0')).toThrow()
    expect(() => validateManifest({ ...good(), notesUrl: 'javascript:alert(1)' }, '0.3.0')).toThrow()
    expect(() => validateManifest(null, '0.3.0')).toThrow()
    expect(() => validateManifest('<!doctype html>', '0.3.0')).toThrow()
  })

  it('同じ名前が2回あれば止める', () => {
    const m = good() as unknown as { files: unknown[] }
    m.files.push(m.files[0])
    expect(() => validateManifest(m, '0.3.0')).toThrow(/重なっている/)
  })
})

describe('版と索引', () => {
  it('版の形でないもの（区切り・記号・引用符）は止める', () => {
    expect(assertValidVersion('0.3.0')).toBe('0.3.0')
    expect(assertValidVersion('1.0.0-beta.1')).toBe('1.0.0-beta.1')
    for (const v of ['../0.3.0', '0.3.0/../../x', '0.3.0 & calc', '0.3.0"', 'latest', '', undefined]) {
      expect(() => assertValidVersion(v)).toThrow()
    }
  })

  it('versions.json の manifest は releases/<version>/manifest.json に限る', () => {
    const ok = { schema: 1, latest: '0.3.0', versions: [{ version: '0.3.0', date: 'x', prerelease: false, manifest: 'releases/0.3.0/manifest.json', files: 2 }] }
    expect(validateIndex(ok)).toBe(ok)
    expect(() => validateIndex({ ...ok, versions: [{ ...ok.versions[0], manifest: 'staging/../secret.json' }] })).toThrow()
    expect(() => validateIndex({ ...ok, versions: [{ ...ok.versions[0], version: '../x' }] })).toThrow()
    expect(() => validateIndex({ ...ok, latest: '$(x)' })).toThrow()
    expect(() => validateIndex({ ...ok, versions: [ok.versions[0], ok.versions[0]] })).toThrow()
  })
})

describe('SHA256SUMS（GitHub Release に置く、R2 とは別の答え合わせ）', () => {
  it('sha256sum の形を読み書きでき、manifest と過不足なく一致すれば通る', () => {
    const m = good()
    const text = formatSha256Sums(m.files)
    expect(text).toBe(`${SHA}  Ferret-0.3.0-mac-arm64.dmg\n${SHA2}  Ferret-0.3.0-win-x64.exe\n`)
    const sums = parseSha256Sums(text)
    expect(() => assertManifestMatchesSums(m, sums)).not.toThrow()
    // バイナリの印（*）付きの行も読む
    expect(parseSha256Sums(`${SHA} *Ferret-0.3.0-mac-arm64.dmg`).get('Ferret-0.3.0-mac-arm64.dmg')).toBe(SHA)
  })

  it('R2 の manifest の sha256 が書き換えられていたら止める', () => {
    const m = good()
    const sums = parseSha256Sums(`${'c'.repeat(64)}  Ferret-0.3.0-mac-arm64.dmg\n${SHA2}  Ferret-0.3.0-win-x64.exe\n`)
    expect(() => assertManifestMatchesSums(m, sums)).toThrow(/書き換えられた/)
  })

  it('片方にしかないファイルがあれば止める', () => {
    const m = good()
    expect(() => assertManifestMatchesSums(m, parseSha256Sums(`${SHA}  Ferret-0.3.0-mac-arm64.dmg\n`))).toThrow()
    expect(() =>
      assertManifestMatchesSums(m, parseSha256Sums(`${formatSha256Sums(m.files)}${SHA}  Ferret-0.3.0-linux-amd64.deb\n`))
    ).toThrow()
  })

  it('パスを含む行・壊れた行・空は読まない', () => {
    expect(() => parseSha256Sums(`${SHA}  ../escape`)).toThrow()
    expect(() => parseSha256Sums(`${SHA}  dir/file`)).toThrow()
    expect(() => parseSha256Sums('not a sum')).toThrow()
    expect(() => parseSha256Sums('')).toThrow()
  })
})

describe('workPath: 作業フォルダの外を指さない', () => {
  it('こちらで付けた名前は作業フォルダの直下になる（posix）', () => {
    expect(workPath('/tmp/ferret-r2-x', 'file-0.bin', path.posix)).toBe('/tmp/ferret-r2-x/file-0.bin')
  })

  it('こちらで付けた名前は作業フォルダの直下になる（win32。ファイルは作らない）', () => {
    expect(workPath('C:\\Temp\\ferret-r2-x', 'file-0.bin', path.win32)).toBe('C:\\Temp\\ferret-r2-x\\file-0.bin')
  })

  it.each(HOSTILE.concat(['..', '.', '', 'a/b', 'a\\b']))('%j は posix でも win32 でも止める', (name) => {
    expect(() => workPath('/tmp/ferret-r2-x', name, path.posix)).toThrow()
    expect(() => workPath('C:\\Temp\\ferret-r2-x', name, path.win32)).toThrow()
  })
})

describe('外の道具の起動（shell を通さない・版を固定する）', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('引数の & | 引用符 $() `` ../ は解釈されず、そのまま1つずつ渡る（目印のファイルも作られない）', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ferret-release-tools-'))
    const hostile = ['a & echo x > pwned1', 'b | echo x > pwned2', '"c" ; echo x > pwned3', '$(echo x > pwned4)', '`echo x > pwned5`', '../escape', "it's"]
    const r = runTool(
      { command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...hostile] },
      { cwd: dir, encoding: 'utf8', shell: true } as never
    )
    expect(r.status).toBe(0)
    expect(JSON.parse(String(r.stdout))).toEqual(hostile)
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(path.join(dir, '..', 'escape'))).toBe(false)
  })

  it('パッケージの指定が完全な版かどうかを見分ける（@latest・^・~・範囲・メジャーだけは不可）', () => {
    expect(isExactPackageSpec('wrangler@4.147.0')).toBe(true)
    expect(isExactPackageSpec('@sentry/cli@2.58.6')).toBe(true)
    for (const spec of ['wrangler@latest', 'wrangler', 'wrangler@4', 'wrangler@^4.1.0', 'wrangler@~4.1.0', 'wrangler@>=4', '@sentry/cli@2', 'x@1.0.0 && calc']) {
      expect(isExactPackageSpec(spec)).toBe(false)
    }
  })
})

describe('GitHub Release（SHA256SUMS だけ）の gh の引数', () => {
  it('下書きで、添付は SHA256SUMS の1つだけ。本文は manifest と同じ値であることと、署名なしを書く', () => {
    const notes = ghReleaseNotes('0.3.0')
    const args = ghReleaseCreateArgs({ version: '0.3.0', repo: 'JapanMarketing-Dev/ferret', sumsFile: '/tmp/x/SHA256SUMS', notes, target: 'abc123', prerelease: true })
    expect(args).toEqual([
      'release', 'create', 'v0.3.0', '/tmp/x/SHA256SUMS',
      '--repo', 'JapanMarketing-Dev/ferret', '--draft', '--title', 'Ferret 0.3.0', '--notes', notes, '--target', 'abc123', '--prerelease'
    ])
    expect(notes).toMatch(/releases\/0\.3\.0\/manifest\.json/)
    expect(notes).toMatch(/not code-signed/)
    expect(notes).toMatch(/not from GitHub/)
    expect(ghReleasePublishArgs({ version: '0.3.0', repo: 'JapanMarketing-Dev/ferret' })).toEqual(['release', 'edit', 'v0.3.0', '--repo', 'JapanMarketing-Dev/ferret', '--draft=false'])
  })

  it('版・リポジトリ・target の形が違えば止める（- で始まる値をオプションにさせない）', () => {
    const base = { version: '0.3.0', repo: 'JapanMarketing-Dev/ferret', sumsFile: 'SHA256SUMS', notes: '' }
    expect(() => ghReleaseCreateArgs({ ...base, version: '0.3.0 --clobber' })).toThrow()
    expect(() => ghReleaseCreateArgs({ ...base, repo: '--repo=evil/x' })).toThrow()
    expect(() => ghReleaseCreateArgs({ ...base, repo: 'evil' })).toThrow()
    expect(() => ghReleaseCreateArgs({ ...base, target: '--draft=false' })).toThrow()
    expect(() => ghReleasePublishArgs({ version: '../x', repo: 'JapanMarketing-Dev/ferret' })).toThrow()
  })
})
