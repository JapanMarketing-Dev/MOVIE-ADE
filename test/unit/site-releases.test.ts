import { describe, expect, it } from 'vitest'
import { DOWNLOAD_BASE, REPO_URL } from '../../site/js/config.js'
import {
  BUILD_DOC_URL,
  SLOTS,
  assetForSlot,
  classifyAsset,
  compareVersions,
  detectPlatform,
  excerptNotes,
  formatBytes,
  formatDate,
  joinUrl,
  normalizeFiles,
  notesLink,
  TRUSTED_DOWNLOAD_ORIGINS,
  normalizeIndex,
  normalizeManifest,
  recommendedSlot
} from '../../site/js/releases.js'

/** ダウンロードサイト（site/）の、R2 の索引・ファイル名・端末の判別 */

const BASE = 'https://downloads.example.com'

const slot = (id: string) => {
  const s = SLOTS.find((x) => x.id === id)
  if (!s) throw new Error(id)
  return s
}

const file = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  path: `releases/0.2.0/${name}`,
  size: 100 * 1024 * 1024,
  sha256: 'abc',
  ...extra
})

describe('classifyAsset', () => {
  it.each([
    ['MOVIE-ADE-0.2.0-mac-arm64.dmg', { os: 'mac', arch: 'arm64', kind: 'dmg' }],
    ['MOVIE-ADE-0.2.0-mac-x64.dmg', { os: 'mac', arch: 'x64', kind: 'dmg' }],
    ['MOVIE-ADE-0.2.0-mac-arm64.zip', { os: 'mac', arch: 'arm64', kind: 'zip' }],
    ['MOVIE-ADE-0.2.0-mac-universal.dmg', { os: 'mac', arch: 'universal', kind: 'dmg' }],
    ['MOVIE-ADE-0.2.0-win-x64.exe', { os: 'win', arch: 'x64', kind: 'exe' }],
    ['MOVIE-ADE-0.2.0-win-arm64.exe', { os: 'win', arch: 'arm64', kind: 'exe' }],
    ['MOVIE-ADE-Setup-0.2.0.exe', { os: 'win', arch: 'x64', kind: 'exe' }],
    ['MOVIE-ADE-0.2.0-linux-x86_64.AppImage', { os: 'linux', arch: 'x64', kind: 'AppImage' }],
    ['MOVIE-ADE-0.2.0-linux-arm64.AppImage', { os: 'linux', arch: 'arm64', kind: 'AppImage' }],
    ['MOVIE-ADE-0.2.0-linux-amd64.deb', { os: 'linux', arch: 'x64', kind: 'deb' }],
    ['movie-ade_0.2.0_arm64.deb', { os: 'linux', arch: 'arm64', kind: 'deb' }],
    ['MOVIE-ADE-0.2.0-linux-aarch64.rpm', { os: 'linux', arch: 'arm64', kind: 'rpm' }],
    ['MOVIE-ADE-0.2.0-linux-x64.tar.gz', { os: 'linux', arch: 'x64', kind: 'tar.gz' }],
    ['MOVIE-ADE-0.2.0-darwin-arm64.zip', { os: 'mac', arch: 'arm64', kind: 'zip' }],
    ['MOVIE-ADE-0.2.0-win-x64.zip', { os: 'win', arch: 'x64', kind: 'zip' }],
    // 0.2.0 以降の改名後（Ferret）の名前
    ['Ferret-0.2.0-mac-arm64.dmg', { os: 'mac', arch: 'arm64', kind: 'dmg' }],
    ['Ferret-0.2.0-mac-x64.dmg', { os: 'mac', arch: 'x64', kind: 'dmg' }],
    ['Ferret-0.2.0-win-x64.exe', { os: 'win', arch: 'x64', kind: 'exe' }],
    ['Ferret-0.2.0-win-arm64.exe', { os: 'win', arch: 'arm64', kind: 'exe' }],
    ['Ferret-0.2.0-linux-x86_64.AppImage', { os: 'linux', arch: 'x64', kind: 'AppImage' }],
    ['Ferret-0.2.0-linux-amd64.deb', { os: 'linux', arch: 'x64', kind: 'deb' }],
    // electron-builder.dev.cjs（cross-platform）の artifactName の形
    ['ade-dev-macos-arm64.dmg', { os: 'mac', arch: 'arm64', kind: 'dmg' }],
    ['ade-dev-windows-arm64-setup.exe', { os: 'win', arch: 'arm64', kind: 'exe' }],
    ['ade-dev-linux-x86_64.AppImage', { os: 'linux', arch: 'x64', kind: 'AppImage' }],
    ['ade-dev_0.2.0_amd64.deb', { os: 'linux', arch: 'x64', kind: 'deb' }]
  ])('%s', (name, expected) => {
    expect(classifyAsset(name)).toEqual(expected)
  })

  it.each([
    'MOVIE-ADE-0.2.0-mac-arm64.dmg.blockmap',
    'latest-mac.yml',
    'latest.yml',
    'manifest.json',
    'SHA256SUMS.txt',
    'MOVIE-ADE-0.2.0-mac-arm64.dmg.sha256',
    'source.zip', // OS が分からない zip
    'README.md',
    'MOVIE-ADE-0.2.0-win-ia32.exe', // 配布しない CPU
    ''
  ])('人がダウンロードしないものは null: %s', (name) => {
    expect(classifyAsset(name)).toBeNull()
  })

  it('"darwin" の中の "win" を Windows と取り違えない', () => {
    expect(classifyAsset('MOVIE-ADE-0.2.0-darwin-x64.zip')?.os).toBe('mac')
  })
})

describe('joinUrl', () => {
  it('ベース URL と相対パスを 1 本の / でつなぎ、各部分をエンコードする', () => {
    expect(joinUrl(`${BASE}/`, '/releases/0.2.0/a b.dmg')).toBe(`${BASE}/releases/0.2.0/a%20b.dmg`)
    expect(joinUrl(BASE, 'latest.json')).toBe(`${BASE}/latest.json`)
  })

  it('絶対 URL は https で、ベースか許した配信元（R2 の公開 URL・ferretade.dev）のものだけ通す', () => {
    expect(TRUSTED_DOWNLOAD_ORIGINS).toEqual([new URL(DOWNLOAD_BASE).origin, 'https://ferretade.dev'])
    expect(joinUrl(BASE, `${BASE}/releases/0.2.0/x.dmg`)).toBe(`${BASE}/releases/0.2.0/x.dmg`)
    expect(joinUrl(BASE, `${DOWNLOAD_BASE}/releases/0.2.0/x.dmg`)).toBe(`${DOWNLOAD_BASE}/releases/0.2.0/x.dmg`)
    expect(joinUrl(BASE, 'https://ferretade.dev/releases/0.2.0/x.dmg')).toBe('https://ferretade.dev/releases/0.2.0/x.dmg')
    // R2 の manifest が書き換えられても、ほかの配信元のインストーラへのリンクは作らない
    expect(joinUrl(BASE, 'https://github.com/x')).toBeNull()
    expect(joinUrl(BASE, 'https://evil.example/Ferret-0.2.0-mac-arm64.dmg')).toBeNull()
    expect(joinUrl(BASE, 'https://ferretade.dev.evil.example/x.dmg')).toBeNull()
    expect(joinUrl(BASE, `https://user@${new URL(BASE).host}/x.dmg`)).toBeNull()
    expect(joinUrl(BASE, `http://${new URL(BASE).host}/x.dmg`)).toBeNull()
    expect(joinUrl(BASE, 'releases/../../x.dmg')).toBeNull()
    expect(joinUrl(BASE, 'releases\\x.dmg')).toBeNull()
    expect(joinUrl(BASE, 'javascript:alert(1)')).toBeNull()
    expect(joinUrl(BASE, '//evil.example/x')).toBeNull()
    expect(joinUrl(BASE, '')).toBeNull()
    expect(joinUrl(BASE, undefined)).toBeNull()
  })

  it('配布元の URL は config.js の1か所にある', () => {
    expect(DOWNLOAD_BASE).toMatch(/^https:\/\/[^/]+$/)
  })
})

describe('normalizeFiles / normalizeManifest', () => {
  it('manifest の os・arch・kind を優先し、無ければ名前から判別する', () => {
    const files = normalizeFiles(
      [
        file('MOVIE-ADE-0.2.0-mac-arm64.dmg', { os: 'mac', arch: 'arm64', kind: 'dmg' }),
        file('MOVIE-ADE-0.2.0-win-x64.exe'),
        file('MOVIE-ADE-0.2.0-installer.exe', { arch: 'arm64' }), // 名前に CPU が無くても manifest で分かる
        file('MOVIE-ADE-0.2.0-linux-x86_64.AppImage', { os: 'bogus', arch: 'bogus' }) // 不正な値は名前で補う
      ],
      BASE
    )
    expect(files.map((f) => [f.name, f.info.os, f.info.arch, f.info.kind])).toEqual([
      ['MOVIE-ADE-0.2.0-mac-arm64.dmg', 'mac', 'arm64', 'dmg'],
      ['MOVIE-ADE-0.2.0-win-x64.exe', 'win', 'x64', 'exe'],
      ['MOVIE-ADE-0.2.0-installer.exe', 'win', 'arm64', 'exe'],
      ['MOVIE-ADE-0.2.0-linux-x86_64.AppImage', 'linux', 'x64', 'AppImage']
    ])
    expect(files[0].url).toBe(`${BASE}/releases/0.2.0/MOVIE-ADE-0.2.0-mac-arm64.dmg`)
  })

  it('Preview は manifest の preview を優先し、無ければ付けない（Windows・Linux も正式対応）', () => {
    const files = normalizeFiles(
      [
        file('MOVIE-ADE-0.1.0-mac-arm64.dmg'),
        file('MOVIE-ADE-0.1.0-win-x64.exe', { preview: true }),
        file('MOVIE-ADE-0.1.0-linux-x86_64.AppImage'),
        file('MOVIE-ADE-0.1.0-linux-amd64.deb', { preview: false })
      ],
      BASE
    )
    expect(files.map((f) => f.preview)).toEqual([false, true, false, false])
  })

  it('自動更新用のファイル・危ない URL・壊れた項目は落とす', () => {
    const files = normalizeFiles(
      [file('latest-mac.yml'), file('MOVIE-ADE-0.2.0-mac-arm64.dmg.blockmap'), file('MOVIE-ADE-0.2.0-mac-x64.dmg', { path: 'javascript:alert(1)' }), null, { size: 1 }],
      BASE
    )
    expect(files).toEqual([])
    expect(normalizeFiles(undefined, BASE)).toEqual([])
  })

  it('manifest を表示用の版に直す。版が無ければ null', () => {
    const release = normalizeManifest(
      { schema: 1, version: 'v0.2.0', date: '2026-10-20T00:00:00Z', notes: '- Fix', notesUrl: `${REPO_URL}/releases/tag/v0.2.0`, files: [file('MOVIE-ADE-0.2.0-mac-arm64.dmg')] },
      BASE
    )
    expect(release).toMatchObject({ version: '0.2.0', tag: 'v0.2.0', prerelease: false, notes: '- Fix', notesUrl: `${REPO_URL}/releases/tag/v0.2.0` })
    expect(release?.assets).toHaveLength(1)
    expect(normalizeManifest(null, BASE)).toBeNull()
    expect(normalizeManifest({ files: [] }, BASE)).toBeNull()
    // R2 の 404 ページ（HTML）を JSON として読めなかった時も、呼び出し側が null を渡すだけで済む
    expect(normalizeManifest('<!doctype html>', BASE)).toBeNull()
  })
})

describe('notesLink: リリースノートのリンク', () => {
  it('GitHub の JapanMarketing-Dev の下（改名前のリポジトリも）と ferretade.dev の https だけを通す', () => {
    expect(notesLink(BASE, `${REPO_URL}/releases/tag/v0.2.0`)).toBe(`${REPO_URL}/releases/tag/v0.2.0`)
    expect(notesLink(BASE, 'https://github.com/JapanMarketing-Dev/MOVIE-ADE/releases/tag/v0.1.0')).toBe('https://github.com/JapanMarketing-Dev/MOVIE-ADE/releases/tag/v0.1.0')
    expect(notesLink(BASE, 'https://github.com/JapanMarketing-Dev/ADE-movie/releases/tag/v0.1.0')).toBe('https://github.com/JapanMarketing-Dev/ADE-movie/releases/tag/v0.1.0')
    expect(notesLink(BASE, 'https://ferretade.dev/changelog')).toBe('https://ferretade.dev/changelog')
  })

  it('偽物・ほかの配信元・http・相対パス・ほかのスキームは落とす', () => {
    for (const url of [
      'https://github.com/JapanMarketing-Dev.evil/ferret/releases',
      'https://github.com.evil.example/JapanMarketing-Dev/ferret',
      'https://github.com/someone-else/ferret/releases',
      'https://github.com/JapanMarketing-Dev',
      'https://user@github.com/JapanMarketing-Dev/ferret',
      'http://github.com/JapanMarketing-Dev/ferret',
      'https://ferretade.dev.evil.example/notes',
      `${BASE}/notes.md`,
      'notes/0.2.0.md',
      'javascript:alert(1)',
      undefined
    ]) {
      expect(notesLink(BASE, url), String(url)).toBeNull()
    }
  })
})

describe('R2 の索引・manifest が別の配信元を指しても、リンクにしない', () => {
  it('ファイルの path がほかの配信元ならそのファイルを落とす', () => {
    const files = normalizeFiles([file('Ferret-0.2.0-mac-arm64.dmg', { path: 'https://evil.example/Ferret-0.2.0-mac-arm64.dmg' }), file('Ferret-0.2.0-mac-x64.dmg')], BASE)
    expect(files.map((f) => f.name)).toEqual(['Ferret-0.2.0-mac-x64.dmg'])
  })

  it('versions.json の manifest がほかの配信元ならその版を落とす（入れ子の manifest も同じ規則）', () => {
    const { all } = normalizeIndex(
      { schema: 1, latest: '0.2.0', versions: [{ version: '0.2.0', date: '2026-10-20', manifest: 'https://evil.example/manifest.json' }, { version: '0.1.0', date: '2026-10-01' }] },
      BASE
    )
    expect(all.map((v) => v.version)).toEqual(['0.1.0'])
  })
})

describe('normalizeIndex', () => {
  it('0 件・壊れた索引なら latest は null（サイトは「Coming soon」を出す）', () => {
    expect(normalizeIndex(null, BASE)).toEqual({ latest: null, all: [] })
    expect(normalizeIndex({ versions: [] }, BASE)).toEqual({ latest: null, all: [] })
    expect(normalizeIndex({ versions: 'x' }, BASE)).toEqual({ latest: null, all: [] })
  })

  it('新しい順に並べ、manifest の URL を作り、latest の指定を最新にする', () => {
    const { latest, all } = normalizeIndex(
      {
        schema: 1,
        latest: '0.2.0',
        versions: [
          { version: '0.1.0', date: '2026-10-03T00:00:00Z', manifest: 'releases/0.1.0/manifest.json' },
          { version: '0.3.0-beta.1', date: '2026-10-25T00:00:00Z', prerelease: true },
          { version: '0.2.0', date: '2026-10-20T00:00:00Z', manifest: 'releases/0.2.0/manifest.json' },
          { date: '2026-12-01T00:00:00Z' }
        ]
      },
      BASE
    )
    expect(all.map((v) => v.tag)).toEqual(['v0.3.0-beta.1', 'v0.2.0', 'v0.1.0'])
    expect(all[0].manifestUrl).toBe(`${BASE}/releases/0.3.0-beta.1/manifest.json`) // 省略時の既定の場所
    expect(latest?.version).toBe('0.2.0')
  })

  it('latest の指定が無ければ、正式版の一番新しいもの', () => {
    const { latest } = normalizeIndex(
      { versions: [{ version: '0.3.0-rc.1', date: '2026-10-25', prerelease: true }, { version: '0.2.0', date: '2026-10-20' }] },
      BASE
    )
    expect(latest?.version).toBe('0.2.0')
  })

  it('日付が同じなら版の数字で並べる', () => {
    const { all } = normalizeIndex({ versions: [{ version: '0.2.9', date: '2026-10-20' }, { version: '0.2.10', date: '2026-10-20' }] }, BASE)
    expect(all.map((v) => v.version)).toEqual(['0.2.10', '0.2.9'])
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
  })
})

describe('改名をまたぐ版の一覧', () => {
  it('0.1.x の MOVIE-ADE-* と 0.2.0 以降の Ferret-* を同じ枠に判別する', () => {
    const old = normalizeManifest({ version: '0.1.1', files: [file('MOVIE-ADE-0.1.1-mac-arm64.dmg'), file('MOVIE-ADE-0.1.1-win-x64.exe', { preview: true })] }, BASE)
    const next = normalizeManifest({ version: '0.2.0', files: [file('Ferret-0.2.0-mac-arm64.dmg'), file('Ferret-0.2.0-win-x64.exe', { preview: true })] }, BASE)
    expect(assetForSlot(old?.assets ?? [], slot('mac-arm64'))?.name).toBe('MOVIE-ADE-0.1.1-mac-arm64.dmg')
    expect(assetForSlot(next?.assets ?? [], slot('mac-arm64'))?.name).toBe('Ferret-0.2.0-mac-arm64.dmg')
    expect(assetForSlot(next?.assets ?? [], slot('win-x64'))?.preview).toBe(true)
    const { latest, all } = normalizeIndex(
      { latest: '0.2.0', versions: [{ version: '0.1.1', date: '2026-10-05' }, { version: '0.2.0', date: '2026-10-10', product: 'Ferret' }] },
      BASE
    )
    expect(all.map((v) => [v.version, v.product])).toEqual([['0.2.0', 'Ferret'], ['0.1.1', 'MOVIE-ADE']])
    expect(latest?.version).toBe('0.2.0')
  })

  it('product が無い・空の版は MOVIE-ADE（0.1.0・0.1.1）、ある版はその名前', () => {
    expect(normalizeManifest({ version: '0.1.0', files: [] }, BASE)?.product).toBe('MOVIE-ADE')
    expect(normalizeManifest({ version: '0.1.1', product: ' ', files: [] }, BASE)?.product).toBe('MOVIE-ADE')
    expect(normalizeManifest({ version: '0.2.0', product: 'Ferret', files: [] }, BASE)?.product).toBe('Ferret')
  })
})

describe('assetForSlot', () => {
  const assets = normalizeFiles(
    [
      file('MOVIE-ADE-0.2.0-mac-arm64.dmg'),
      file('MOVIE-ADE-0.2.0-mac-arm64.zip'),
      file('MOVIE-ADE-0.2.0-win-x64.exe'),
      file('MOVIE-ADE-0.2.0-linux-x86_64.AppImage'),
      file('MOVIE-ADE-0.2.0-linux-amd64.deb')
    ],
    BASE
  )

  it('枠に合うファイルを、種類の優先順で選ぶ（dmg を zip より先に）', () => {
    expect(assetForSlot(assets, slot('mac-arm64'))?.name).toBe('MOVIE-ADE-0.2.0-mac-arm64.dmg')
    expect(assetForSlot(assets, slot('win-x64'))?.name).toBe('MOVIE-ADE-0.2.0-win-x64.exe')
    expect(assetForSlot(assets, slot('linux-appimage'))?.name).toBe('MOVIE-ADE-0.2.0-linux-x86_64.AppImage')
    expect(assetForSlot(assets, slot('linux-deb'))?.name).toBe('MOVIE-ADE-0.2.0-linux-amd64.deb')
  })

  it('無い枠は null', () => {
    expect(assetForSlot(assets, slot('mac-x64'))).toBeNull()
    expect(assetForSlot(assets, slot('win-arm64'))).toBeNull()
  })

  it('mac の universal は Apple silicon・Intel の両方の枠を埋める', () => {
    const universal = normalizeFiles([file('MOVIE-ADE-0.2.0-mac-universal.dmg')], BASE)
    expect(assetForSlot(universal, slot('mac-arm64'))?.name).toBe('MOVIE-ADE-0.2.0-mac-universal.dmg')
    expect(assetForSlot(universal, slot('mac-x64'))?.name).toBe('MOVIE-ADE-0.2.0-mac-universal.dmg')
  })

  it('どの枠も Preview ではない（Windows・Linux も正式対応）', () => {
    expect(SLOTS.filter((s) => s.preview)).toEqual([])
  })
})

describe('detectPlatform / recommendedSlot', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

  it('mac は CPU が分からなければ Apple silicon を勧める（UA の "Intel" は当てにしない）', () => {
    const p = detectPlatform({ userAgent: mac, platform: 'MacIntel' })
    expect(p).toEqual({ os: 'mac', arch: null, mobile: false })
    expect(recommendedSlot(p)?.id).toBe('mac-arm64')
  })

  it('Client Hints で x86 と分かる mac は Intel', () => {
    expect(recommendedSlot(detectPlatform({ userAgent: mac, uaPlatform: 'macOS', uaArch: 'x86' }))?.id).toBe('mac-x64')
  })

  it('Windows は x64、Client Hints で arm なら arm64', () => {
    expect(recommendedSlot(detectPlatform({ userAgent: win, platform: 'Win32' }))?.id).toBe('win-x64')
    expect(recommendedSlot(detectPlatform({ userAgent: win, uaPlatform: 'Windows', uaArch: 'arm' }))?.id).toBe('win-arm64')
  })

  it('Linux は .deb を先に勧める（AppImage は次）', () => {
    const p = detectPlatform({ userAgent: linux, platform: 'Linux x86_64' })
    expect(p).toEqual({ os: 'linux', arch: 'x64', mobile: false })
    expect(recommendedSlot(p)?.id).toBe('linux-deb')
    expect(SLOTS.filter((s) => s.os === 'linux').map((s) => s.id)).toEqual(['linux-deb', 'linux-appimage'])
  })

  it('スマホ・iPad は OS なし（ボタンはダウンロードページへ）', () => {
    expect(detectPlatform({ userAgent: iphone, platform: 'iPhone' })).toEqual({ os: null, arch: null, mobile: true })
    expect(detectPlatform({ userAgent: ipad, platform: 'MacIntel' }).mobile).toBe(true)
    expect(recommendedSlot(detectPlatform({ userAgent: iphone }))).toBeNull()
  })

  it('何も分からなければ null', () => {
    expect(detectPlatform({})).toEqual({ os: null, arch: null, mobile: false })
    expect(recommendedSlot(null)).toBeNull()
  })
})

describe('整形', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(123.4 * 1024 * 1024)).toBe('123 MB')
  })

  it('formatDate は英語の短い日付', () => {
    expect(formatDate('2026-10-03T01:02:03Z')).toBe('Oct 3, 2026')
    expect(formatDate('2026-13-01')).toBe('')
    expect(formatDate('')).toBe('')
  })

  it('excerptNotes は Markdown の装飾を外し、コードと空行を飛ばして先頭だけ返す', () => {
    const body = [
      '## Changes',
      '',
      '- **Windows** builds ([#12](https://example.com/12))',
      '* `x86_64` AppImage',
      '```sh',
      'pnpm install',
      '```',
      '<!-- internal -->',
      '![image](a.png)',
      '<img src="x" onerror="alert(1)">Fix',
      '3',
      '4',
      '5'
    ].join('\n')
    expect(excerptNotes(body, 6)).toEqual(['Changes', 'Windows builds (#12)', 'x86_64 AppImage', 'Fix', '3', '4'])
    expect(excerptNotes(body)).toHaveLength(7) // 既定は8行まで
    expect(excerptNotes('x'.repeat(300))[0]).toHaveLength(280)
    expect(excerptNotes(body, 2)).toHaveLength(2)
    expect(excerptNotes(undefined as unknown as string)).toEqual([])
  })

  it('excerptNotes は複数行・閉じていない HTML のコメントと、外すと新しくできるタグも残さない', () => {
    expect(excerptNotes('a\n<!-- one\ntwo -->\nb')).toEqual(['a', 'b'])
    expect(excerptNotes('a\n<!-- x --!>b')).toEqual(['a', 'b'])
    expect(excerptNotes('a\n<!-- never closed\nb')).toEqual(['a'])
    expect(excerptNotes('<!<!--- -->-- x -->y')).toEqual(['y'])
    expect(excerptNotes('<<b>script>alert(1)<</b>/script>ok')).toEqual(['script>alert(1)/script>ok'])
  })
})

it('ビルド手順へのリンクは英語の README の見出し「Install and run」', () => {
  expect(REPO_URL).toBe('https://github.com/JapanMarketing-Dev/ferret')
  expect(BUILD_DOC_URL).toBe(`${REPO_URL}#install-and-run`)
})
