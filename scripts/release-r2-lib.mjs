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

/**
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
