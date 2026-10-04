/**
 * R2 へのリリースで使う純粋関数（入出力なし。test/unit/release-r2.test.ts で確かめる）。
 * 形式は download-site と合意したもの（site/js/releases.js が読む）。
 *
 *   versions.json                 … 全版の索引（新しい順・最大 KEEP_VERSIONS 版）
 *   latest.json                   … 最新の正式版の manifest.json と同じ中身
 *   releases/<version>/manifest.json
 *   releases/<version>/<ファイル名>
 *   staging/<version>/…          … 公開前の置き場（manifest の path は公開後の releases/ を指す）
 */

export const SCHEMA = 1
/** R2 に残す版の数（ユーザーの決定。保存は月 10GB まで無料なので、1版 1GB 弱として 10版） */
export const KEEP_VERSIONS = 10
/** 各版のファイルは中身が変わらない */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
/** 各版の manifest.json。差し替え（--replace）で中身が変わるので、索引と同じく短く */
export const MANIFEST_CACHE = 'public, max-age=300'
/** 公開前の置き場。差し替えることがあるので長く覚えさせない */
export const STAGING_CACHE = 'no-store'
/** 索引は新しい版がすぐ見えるよう短く */
export const INDEX_CACHE = 'public, max-age=300'

const KIND_BY_EXT = { dmg: 'dmg', exe: 'exe', AppImage: 'AppImage', deb: 'deb' }
const ARCH_ALIASES = { arm64: 'arm64', aarch64: 'arm64', x64: 'x64', x86_64: 'x64', amd64: 'x64', universal: 'universal' }

export const CONTENT_TYPES = {
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  AppImage: 'application/vnd.appimage',
  deb: 'application/vnd.debian.binary-package'
}

/** 製品名。0.2.0 から Ferret（それまでは MOVIE-ADE）。ファイル名の先頭でもある */
export const PRODUCTS = ['Ferret', 'MOVIE-ADE']

/**
 * 配布物のファイル名を読む。<製品名>-<version>-<os>-<arch>.<ext> 以外（.blockmap・latest*.yml・別の版）は null。
 * @returns {{ name: string, product: string, os: 'mac'|'win'|'linux', arch: string, kind: string } | null}
 */
export function parseArtifactName(name, version) {
  const escaped = version.replace(/[.+]/g, (c) => `\\${c}`)
  const match = new RegExp(`^(${PRODUCTS.join('|')})-${escaped}-(mac|win|linux)-([A-Za-z0-9_]+)\\.(dmg|exe|AppImage|deb)$`).exec(name)
  if (!match) return null
  const arch = ARCH_ALIASES[match[3]]
  if (!arch) return null
  return { name, product: match[1], os: match[2], arch, kind: KIND_BY_EXT[match[4]] }
}

/** 版の大小を比べる（1.2.10 > 1.2.9、1.0.0 > 1.0.0-beta.1）。新しい方が前に来るよう sort に使う */
export function compareVersionsDesc(a, b) {
  const split = (v) => {
    const [core, pre] = v.split('-', 2)
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre ?? null }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (y.nums[i] ?? 0) - (x.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return -1
  if (y.pre === null) return 1
  return y.pre.localeCompare(x.pre, 'en', { numeric: true })
}

/**
 * 各版の manifest.json を作る。
 * @param {{ version: string, date: string, prerelease: boolean, notes: string, notesUrl?: string,
 *           files: Array<{ name: string, os: string, arch: string, kind: string, size: number, sha256: string }>,
 *           previewOs?: string[], build?: number, product?: string }} input
 *
 * product は製品名（Ferret / MOVIE-ADE）。サイトが版ごとの名前を出すのに使う。
 *
 * build は同じ版を作り直した回数（1 から）。2 以上なら releases/<version>/b<build>/ に置く。
 * ファイル名は変えずに URL だけを変えるので、ブラウザや将来の CDN が古いファイルを返すことはなく、
 * サイトの判別（ファイル名から OS と CPU を読む）もそのまま使える。
 */
export function buildManifest(input) {
  const preview = new Set(input.previewOs ?? [])
  const build = input.build ?? 1
  const dir = build > 1 ? `releases/${input.version}/b${build}` : `releases/${input.version}`
  const order = { mac: 0, win: 1, linux: 2 }
  const files = [...input.files]
    .sort((a, b) => order[a.os] - order[b.os] || a.arch.localeCompare(b.arch) || a.kind.localeCompare(b.kind))
    .map((f) => ({
      name: f.name,
      path: `${dir}/${f.name}`,
      size: f.size,
      sha256: f.sha256,
      os: f.os,
      arch: f.arch,
      kind: f.kind,
      ...(preview.has(f.os) ? { preview: true } : {})
    }))
  return {
    schema: SCHEMA,
    version: input.version,
    ...(input.product ? { product: input.product } : {}),
    ...(build > 1 ? { build } : {}),
    date: input.date,
    prerelease: input.prerelease,
    notes: input.notes,
    ...(input.notesUrl ? { notesUrl: input.notesUrl } : {}),
    files
  }
}

/** 空の索引 */
export function emptyIndex() {
  return { schema: SCHEMA, latest: null, versions: [] }
}

/**
 * 新しい版を索引に足し、新しい順に並べ、KEEP_VERSIONS 版を超えた古い版を外す。
 * 同じ版がすでにあれば例外（二重アップロードを防ぐ）。
 * @returns {{ index: object, removed: Array<{ version: string, manifest: string }> }}
 */
export function addVersionToIndex(index, manifest, keep = KEEP_VERSIONS) {
  const current = index?.versions ?? []
  if (current.some((v) => v.version === manifest.version)) {
    throw new Error(`${manifest.version} はすでに R2 にあります。同じ版を上げ直すことはしません（版を上げてください）`)
  }
  const entry = {
    version: manifest.version,
    ...(manifest.product ? { product: manifest.product } : {}),
    date: manifest.date,
    prerelease: manifest.prerelease,
    manifest: `releases/${manifest.version}/manifest.json`,
    files: manifest.files.length
  }
  const all = [entry, ...current].sort((a, b) => compareVersionsDesc(a.version, b.version))
  const kept = all.slice(0, keep)
  const removed = all.slice(keep).map((v) => ({ version: v.version, manifest: v.manifest }))
  const latest = kept.find((v) => !v.prerelease)?.version ?? null
  return { index: { schema: SCHEMA, latest, versions: kept }, removed }
}

/** 公開前の置き場のキー（releases/<version>/x → staging/<version>/x） */
export function stagingKey(releasePath) {
  return releasePath.replace(/^releases\//, 'staging/')
}

/**
 * 公開済みの版を差し替えた索引を作る（--replace）。版の位置と数は変えず、日付・ファイル数・prerelease を新しくする。
 * @returns {object} 新しい索引
 */
export function replaceVersionInIndex(index, manifest) {
  const current = index?.versions ?? []
  if (!current.some((v) => v.version === manifest.version)) {
    throw new Error(`${manifest.version} は公開されていないので、差し替えられません（--replace を外す）`)
  }
  const versions = current.map((v) =>
    v.version === manifest.version
      ? { ...v, date: manifest.date, prerelease: manifest.prerelease, files: manifest.files.length }
      : v
  )
  const latest = versions.find((v) => !v.prerelease)?.version ?? null
  return { schema: SCHEMA, latest, versions }
}

/** 差し替えで消す古いファイル（新しい manifest に同じ path が無いもの） */
export function obsoleteFiles(oldManifest, newManifest) {
  const keep = new Set(newManifest.files.map((f) => f.path))
  return (oldManifest?.files ?? []).map((f) => f.path).filter((p) => !keep.has(p))
}

/* ── 外から来た値（R2 の JSON・引数）の検証 ─────────────────────────
 * R2 の中身は、トークンが漏れれば書き換えられる。promote / discard は manifest と索引を R2 から読むので、
 * 形を厳しく確かめてから使う（キーにもローカルのパスにも、確かめていない値を使わない）。 */

/** wrangler で1回に上げられる大きさの上限（300 MiB）。manifest の size もこれを超えない */
export const PUT_LIMIT_BYTES = 300 * 1024 * 1024
/** 1つの版に置くファイルの数の上限（今は6件。余裕を見て） */
const MAX_FILES = 32
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/
const SHA256_RE = /^[0-9a-f]{64}$/

/** 版の文字列として正しいか（1.2.3 / 1.2.3-beta.1）。R2 のキーとローカルのパスに使うので、記号や区切りを通さない */
export function isValidVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version)
}

/** 版が正しくなければ例外 */
export function assertValidVersion(version) {
  if (!isValidVersion(version)) throw new Error(`版の形が正しくありません: ${JSON.stringify(version)}（例 0.2.0 / 0.2.0-beta.1）`)
  return version
}

/** 版のファイルを置くフォルダ（buildManifest と同じ規則） */
export function releaseDir(version, build = 1) {
  return build > 1 ? `releases/${version}/b${build}` : `releases/${version}`
}

/**
 * R2 から読んだ manifest.json を確かめる。形が少しでも違えば例外（fail-closed）。
 * name は配布物の名前の規則どおりの basename、path は releases/<version>[/b<build>]/<name> に限る。
 * @param {unknown} manifest
 * @param {string} version 期待する版
 * @returns {import('./release-r2-lib.d.mts').ReleaseManifest}
 */
/**
 * 公開済みの manifest のリリースノートだけを差し替えた manifest（ファイル・sha256・日付は変えない）。形を確かめて返す
 * @param {any} manifest R2 から読んで validateManifest を通したもの
 * @param {string} notes
 */
export function withNotes(manifest, notes) {
  if (typeof notes !== 'string' || !notes.trim()) throw new Error('リリースノートが空です')
  return validateManifest({ ...manifest, notes }, manifest.version)
}

export function validateManifest(manifest, version) {
  assertValidVersion(version)
  const fail = (why) => {
    throw new Error(`manifest（${version}）の形が正しくありません: ${why}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('オブジェクトではない')
  const m = /** @type {Record<string, unknown>} */ (manifest)
  if (m.schema !== SCHEMA) fail('schema が 1 ではない')
  if (m.version !== version) fail(`version が ${JSON.stringify(m.version)}`)
  if (m.product !== undefined && !PRODUCTS.includes(/** @type {string} */ (m.product))) fail('product が知らない名前')
  if (m.build !== undefined && !(Number.isInteger(m.build) && /** @type {number} */ (m.build) >= 1 && /** @type {number} */ (m.build) <= 999)) fail('build が正の整数ではない')
  if (typeof m.date !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(m.date)) fail('date が ISO 8601 ではない')
  if (typeof m.prerelease !== 'boolean') fail('prerelease が真偽値ではない')
  if (typeof m.notes !== 'string') fail('notes が文字列ではない')
  if (m.notesUrl !== undefined && (typeof m.notesUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(m.notesUrl))) fail('notesUrl が https の URL ではない')
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > MAX_FILES) fail('files が空か多すぎる')
  const dir = releaseDir(version, /** @type {number|undefined} */ (m.build) ?? 1)
  const names = new Set()
  for (const f of /** @type {unknown[]} */ (m.files)) {
    if (!f || typeof f !== 'object') fail('files の要素がオブジェクトではない')
    const file = /** @type {Record<string, unknown>} */ (f)
    const parsed = typeof file.name === 'string' ? parseArtifactName(file.name, version) : null
    if (!parsed) fail(`ファイル名が配布物の規則に合わない: ${JSON.stringify(file.name)}`)
    if (names.has(parsed.name)) fail(`ファイル名が重なっている: ${parsed.name}`)
    names.add(parsed.name)
    if (m.product !== undefined && parsed.product !== m.product) fail(`${parsed.name} の製品名が manifest と違う`)
    if (file.path !== `${dir}/${parsed.name}`) fail(`${parsed.name} の path が ${dir}/ の下ではない: ${JSON.stringify(file.path)}`)
    if (file.os !== parsed.os || file.arch !== parsed.arch || file.kind !== parsed.kind) fail(`${parsed.name} の os / arch / kind が名前と合わない`)
    if (!Number.isInteger(file.size) || /** @type {number} */ (file.size) <= 0 || /** @type {number} */ (file.size) > PUT_LIMIT_BYTES) fail(`${parsed.name} の size が正しくない`)
    if (typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) fail(`${parsed.name} の sha256 が 64 桁の16進ではない`)
    if (file.preview !== undefined && file.preview !== true) fail(`${parsed.name} の preview が true ではない`)
  }
  return /** @type {any} */ (manifest)
}

/**
 * R2 から読んだ versions.json を確かめる。各版の manifest は releases/<version>/manifest.json に限る。
 * @param {unknown} index
 * @returns {import('./release-r2-lib.d.mts').VersionsIndex}
 */
export function validateIndex(index) {
  const fail = (why) => {
    throw new Error(`versions.json の形が正しくありません: ${why}`)
  }
  if (!index || typeof index !== 'object' || Array.isArray(index)) fail('オブジェクトではない')
  const x = /** @type {Record<string, unknown>} */ (index)
  if (x.schema !== SCHEMA) fail('schema が 1 ではない')
  if (x.latest !== null && !isValidVersion(x.latest)) fail('latest が版の形ではない')
  if (!Array.isArray(x.versions)) fail('versions が配列ではない')
  const seen = new Set()
  for (const v of /** @type {unknown[]} */ (x.versions)) {
    const e = /** @type {Record<string, unknown>} */ (v ?? {})
    if (!isValidVersion(e.version)) fail(`版の形ではない: ${JSON.stringify(e.version)}`)
    if (seen.has(e.version)) fail(`版が重なっている: ${e.version}`)
    seen.add(e.version)
    if (e.manifest !== `releases/${e.version}/manifest.json`) fail(`${e.version} の manifest の場所が違う: ${JSON.stringify(e.manifest)}`)
  }
  return /** @type {any} */ (index)
}

/**
 * SHA256SUMS（`sha256sum` の出力。「<64桁>  <名前>」または「<64桁> *<名前>」）を読む。
 * GitHub Release に置く、R2 とは別の場所の答え合わせに使う。
 * @param {string} text
 * @returns {Map<string, string>} 名前 → sha256
 */
export function parseSha256Sums(text) {
  const sums = new Map()
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^([0-9a-fA-F]{64}) [ *]([^\s/\\]+)$/.exec(line)
    if (!m) throw new Error(`SHA256SUMS の行が読めません: ${JSON.stringify(line)}`)
    if (sums.has(m[2])) throw new Error(`SHA256SUMS に同じ名前が2回あります: ${m[2]}`)
    sums.set(m[2], m[1].toLowerCase())
  }
  if (sums.size === 0) throw new Error('SHA256SUMS が空です')
  return sums
}

/** SHA256SUMS の形で書く（`sha256sum` と同じ。名前の順） */
export function formatSha256Sums(files) {
  return [...files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `${f.sha256}  ${f.name}\n`).join('')
}

/**
 * manifest のファイルと SHA256SUMS が過不足なく一致するかを確かめる。違えば例外。
 * @param {{ files: Array<{ name: string, sha256: string }> }} manifest
 * @param {Map<string, string>} sums
 */
export function assertManifestMatchesSums(manifest, sums) {
  const names = new Set(manifest.files.map((f) => f.name))
  for (const f of manifest.files) {
    const expected = sums.get(f.name)
    if (!expected) throw new Error(`${f.name} が SHA256SUMS にありません`)
    if (expected !== f.sha256) throw new Error(`${f.name} の sha256 が SHA256SUMS と違います（R2 の manifest が書き換えられた可能性があります）`)
  }
  for (const name of sums.keys()) {
    if (!names.has(name)) throw new Error(`SHA256SUMS にある ${name} が manifest にありません`)
  }
}

/**
 * 作業フォルダの中のパスを作る。名前は呼び出し側が作ったもの（manifest の値は使わない）に限るが、
 * 念のため区切り・.. を含むもの、フォルダの外に出るものは例外にする。
 * @param {string} work mkdtemp で作ったフォルダ
 * @param {string} name
 * @param {{ resolve: (...p: string[]) => string, relative: (a: string, b: string) => string, isAbsolute: (p: string) => boolean, sep: string }} path node:path（テストで win32 を渡せるように）
 */
export function workPath(work, name, path) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error(`作業フォルダのファイル名にできない名前です: ${JSON.stringify(name)}`)
  }
  const full = path.resolve(work, name)
  const rel = path.relative(path.resolve(work), full)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error(`作業フォルダの外を指しています: ${JSON.stringify(name)}`)
  }
  return full
}

/**
 * npm のパッケージ指定が版を固定しているか（wrangler@4.1.2 など）。@latest・^・~・範囲・タグは通さない。
 * @param {string} spec
 */
export function isExactPackageSpec(spec) {
  return typeof spec === 'string' && /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec)
}

/* ── GitHub Release（SHA256SUMS だけを置く。インストーラーは R2 だけ） ───────────────── */

const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/
const REF_RE = /^[A-Za-z0-9][\w./-]*$/

/**
 * SHA256SUMS だけを付けた GitHub Release の下書きを作る gh の引数。値は manifest と同じもの（formatSha256Sums）を出す。
 * shell は通さずに gh へ渡す前提だが、repo・target・版の形もここで確かめる（- で始まる値をオプションと取り違えさせない）。
 * sigFile（SHA256SUMS.sig。scripts/release-signing.mjs）を渡すと、それも並べて付ける（security-3 [2]）。
 * @param {{ version: string, repo: string, sumsFile: string, sigFile?: string, notes: string, target?: string, prerelease?: boolean, product?: string }} input
 */
export function ghReleaseCreateArgs(input) {
  assertValidVersion(input.version)
  if (!REPO_RE.test(input.repo ?? '')) throw new Error(`リポジトリの形が正しくありません: ${JSON.stringify(input.repo)}（owner/name）`)
  if (input.target !== undefined && !REF_RE.test(input.target)) throw new Error(`target の形が正しくありません: ${JSON.stringify(input.target)}`)
  return [
    'release', 'create', `v${input.version}`, input.sumsFile, ...(input.sigFile ? [input.sigFile] : []),
    '--repo', input.repo,
    '--draft',
    '--title', `${input.product ?? 'Ferret'} ${input.version}`,
    '--notes', input.notes,
    ...(input.target ? ['--target', input.target] : []),
    ...(input.prerelease ? ['--prerelease'] : [])
  ]
}

/** 下書きを公開する gh の引数（promote が済んでから） */
export function ghReleasePublishArgs(input) {
  assertValidVersion(input.version)
  if (!REPO_RE.test(input.repo ?? '')) throw new Error(`リポジトリの形が正しくありません: ${JSON.stringify(input.repo)}（owner/name）`)
  return ['release', 'edit', `v${input.version}`, '--repo', input.repo, '--draft=false']
}

/** GitHub Release の本文。SHA256SUMS が何で、何を保証しないかを書く */
export function ghReleaseNotes(version, downloadUrl = 'https://ferretade.dev/download') {
  assertValidVersion(version)
  return [
    `Ferret ${version}`,
    '',
    `Download: ${downloadUrl}`,
    '',
    'The installers are served only from the download server (Cloudflare R2), not from GitHub.',
    `\`SHA256SUMS\` lists the SHA-256 of each installer, the same values as \`releases/${version}/manifest.json\` on the download server. It is kept here, apart from the download server, so you can check a download against a second source.`,
    '',
    '`SHA256SUMS.sig` is a signature of `SHA256SUMS` by the Ferret release key, which is kept apart from the download server. The public key is in the repository (`build/release-signing/allowed_signers`, also in SECURITY.md). Check it with:',
    '',
    '```',
    'ssh-keygen -Y verify -f allowed_signers -I release@ferretade.dev -n ferret-release -s SHA256SUMS.sig < SHA256SUMS',
    '```',
    '',
    'The macOS app is signed with a Developer ID and notarized by Apple. A matching hash in a correctly signed `SHA256SUMS` shows the file is the one the Ferret release key published.',
    ''
  ].join('\n')
}
