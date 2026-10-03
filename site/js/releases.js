/*
 * 配布元（Cloudflare R2）の索引を、ダウンロードの表示に使える形へ直す純粋関数。
 * DOM・fetch・ストレージには触らない（test/unit/site-releases.test.ts から直接 import する）。
 *
 * R2 の配置（cross-platform と取り決め）:
 *   versions.json                 { schema, latest, versions: [{ version, date, prerelease, manifest }] }
 *   latest.json                   最新の正式版の manifest.json と同じ中身
 *   releases/<version>/manifest.json
 *                                 { schema, version, date, prerelease, notes, notesUrl?, files: [{ name, path, size, sha256, os, arch, kind }] }
 * path はバケット直下からの相対。ベース URL は config.js の DOWNLOAD_BASE を前に付ける。
 *
 * ファイル名の規則: <製品名>-<version>-<os>-<arch>.<ext>
 *   0.1.x は MOVIE-ADE-0.1.0-mac-arm64.dmg、0.2.0 以降は Ferret-0.2.0-mac-arm64.dmg（改名）。
 *   判別は OS・CPU の語と拡張子だけを見るので、製品名の部分は問わない（versions.json に両方が並んでも同じに扱う）。
 * manifest の os・arch・kind を優先し、無い・不正な時だけ名前から判別する。
 */

import { DOWNLOAD_BASE, REPO_URL, SITE_URL } from './config.js?v=412f94b4'

// 英語の README の見出し「Install and run」
export const BUILD_DOC_URL = `${REPO_URL}#install-and-run`

/** 拡張子 → 種類。長いものから順に照合する（.tar.gz を .gz より先に） */
const KINDS = [
  ['.appimage', 'AppImage'],
  ['.tar.gz', 'tar.gz'],
  ['.dmg', 'dmg'],
  ['.pkg', 'pkg'],
  ['.zip', 'zip'],
  ['.exe', 'exe'],
  ['.msi', 'msi'],
  ['.deb', 'deb'],
  ['.rpm', 'rpm'],
  ['.snap', 'snap'],
]

/** 自動更新用・署名用など、人がダウンロードしないファイル */
const IGNORED = /(\.blockmap|\.yml|\.yaml|\.sig|\.asc|\.sha\d*|\.sha\d+sum|\.txt|\.json)$/i

const OS_BY_KIND = { dmg: 'mac', pkg: 'mac', exe: 'win', msi: 'win', AppImage: 'linux', deb: 'linux', rpm: 'linux', snap: 'linux' }
const OSES = ['mac', 'win', 'linux']

/** 今の製品名と、manifest・索引に product が無い版（0.1.0・0.1.1）の製品名 */
export const CURRENT_PRODUCT = 'Ferret'
export const LEGACY_PRODUCT = 'MOVIE-ADE'
const productOf = (item) => (typeof item?.product === 'string' && item.product.trim() ? item.product.trim() : LEGACY_PRODUCT)
const ARCHES = ['arm64', 'x64', 'universal']

/**
 * ファイル名から OS・CPU・種類を判別する。人がダウンロードするものでなければ null。
 * @param {string} name
 * @returns {{ os: 'mac'|'win'|'linux', arch: 'arm64'|'x64'|'universal', kind: string } | null}
 */
export function classifyAsset(name) {
  if (typeof name !== 'string' || !name) return null
  const lower = name.toLowerCase()
  if (IGNORED.test(lower)) return null
  const hit = KINDS.find(([ext]) => lower.endsWith(ext))
  if (!hit) return null
  const kind = hit[1]
  // 区切りで単語に分けてから見る（"darwin" の "win" などを誤って拾わない）
  const words = lower
    .slice(0, -hit[0].length)
    .replace(/x86[_-]64/g, 'x64')
    .split(/[^a-z0-9]+/)
  const has = (...w) => w.some((x) => words.includes(x))

  let os = OS_BY_KIND[kind] ?? null
  if (!os) {
    if (has('mac', 'macos', 'osx', 'darwin')) os = 'mac'
    else if (has('win', 'windows', 'win32', 'win64')) os = 'win'
    else if (has('linux')) os = 'linux'
  }
  if (!os) return null

  let arch = 'x64'
  if (has('arm64', 'aarch64')) arch = 'arm64'
  else if (has('universal')) arch = 'universal'
  else if (has('x64', 'amd64', 'intel', 'win64')) arch = 'x64'
  else if (has('ia32', 'x86', 'i386', 'armv7l')) return null // 配布しない CPU
  return { os, arch, kind }
}

/**
 * 配布物と manifest を置いてよい配信元（R2 の公開 URL と、サイト自身）。
 * 索引や manifest は R2 にあり、R2 を書き換えられると任意の URL を指せてしまうので、ここに無い配信元へのリンクは作らない。
 */
export const TRUSTED_DOWNLOAD_ORIGINS = [new URL(DOWNLOAD_BASE).origin, new URL(SITE_URL).origin]

const originOf = (url) => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * ベース URL と相対パスをつなぐ。絶対 URL は https で、配信元がベースか TRUSTED_DOWNLOAD_ORIGINS のものだけを通す。
 * それ以外の配信元・http・ほかのスキーム（javascript: など）・. や .. の区切りは null。
 * @param {string} base
 * @param {string} path
 * @param {string[]} [origins] ベースのほかに許す配信元
 */
export function joinUrl(base, path, origins = TRUSTED_DOWNLOAD_ORIGINS) {
  if (typeof path !== 'string' || !path) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
    if (!/^https:\/\//i.test(path)) return null
    let url
    try {
      url = new URL(path)
    } catch {
      return null
    }
    if (url.username || url.password) return null
    const allowed = [originOf(base), ...origins].filter(Boolean)
    return allowed.includes(url.origin) ? url.href : null
  }
  const parts = path.replace(/^\/+/, '').split('/')
  if (parts.some((p) => p === '.' || p === '..')) return null
  return `${String(base).replace(/\/+$/, '')}/${parts.map(encodeURIComponent).join('/')}`
}

/** リリースノートの全文を置いてよい場所。GitHub の組織の下（ferret と改名前のリポジトリ）と、サイト自身 */
const NOTES_GITHUB_PREFIX = `${new URL(REPO_URL).origin}${new URL(REPO_URL).pathname.split('/').slice(0, 2).join('/')}/`

/**
 * リリースノートの全文へのリンク。https で、GitHub の JapanMarketing-Dev の下か、サイト（SITE_URL）のものだけを通す。
 * パスの先頭まで見るので、github.com/JapanMarketing-Dev.evil/… や github.com.evil.example は通らない。
 * @param {string} _base 使わない（ほかの normalize と呼び方をそろえるため）
 * @param {unknown} url
 */
export function notesLink(_base, url) {
  if (typeof url !== 'string' || !url) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
  if (parsed.href.startsWith(NOTES_GITHUB_PREFIX)) return parsed.href
  if (parsed.origin === new URL(SITE_URL).origin) return parsed.href
  return null
}

/** ダウンロードページに並べる最新版の枠。Preview の印は manifest の preview（0.3.0 までの Windows・Linux）だけで付ける */
export const SLOTS = [
  { id: 'mac-arm64', os: 'mac', arch: 'arm64', kinds: ['dmg', 'zip'], label: 'macOS', detail: 'Apple silicon', preview: false },
  { id: 'mac-x64', os: 'mac', arch: 'x64', kinds: ['dmg', 'zip'], label: 'macOS', detail: 'Intel', preview: false },
  { id: 'win-x64', os: 'win', arch: 'x64', kinds: ['exe', 'msi', 'zip'], label: 'Windows', detail: 'x64', preview: false },
  { id: 'win-arm64', os: 'win', arch: 'arm64', kinds: ['exe', 'msi', 'zip'], label: 'Windows', detail: 'Arm64', preview: false },
  { id: 'linux-appimage', os: 'linux', arch: 'x64', kinds: ['AppImage'], label: 'Linux', detail: 'AppImage (x64)', preview: false },
  { id: 'linux-deb', os: 'linux', arch: 'x64', kinds: ['deb'], label: 'Linux', detail: '.deb (x64)', preview: false },
]

/** 正式に対応している OS。manifest に preview が無いとき、これ以外を Preview と表示する */
export const VERIFIED_OS = ['mac', 'win', 'linux']

/**
 * manifest の files を、判別つきのダウンロードに直す。判別できない・URL にできないものは落とす。
 * @param {any[]} files
 * @param {string} base
 */
export function normalizeFiles(files, base) {
  if (!Array.isArray(files)) return []
  const out = []
  for (const f of files) {
    if (!f || typeof f.name !== 'string') continue
    const guessed = classifyAsset(f.name)
    if (!guessed) continue
    const info = {
      os: OSES.includes(f.os) ? f.os : guessed.os,
      arch: ARCHES.includes(f.arch) ? f.arch : guessed.arch,
      kind: typeof f.kind === 'string' && f.kind ? f.kind : guessed.kind,
    }
    const url = joinUrl(base, f.path ?? f.name)
    if (!url) continue
    // manifest の preview を優先し、無ければ正式対応でない OS を Preview にする
    const preview = typeof f.preview === 'boolean' ? f.preview : !VERIFIED_OS.includes(info.os)
    out.push({ name: f.name, url, size: Number.isFinite(f.size) ? f.size : 0, sha256: typeof f.sha256 === 'string' ? f.sha256 : '', preview, info })
  }
  return out
}

/**
 * manifest.json（latest.json も同じ形）を表示用の版に直す。版が読めなければ null。
 * @param {any} manifest
 * @param {string} base
 */
export function normalizeManifest(manifest, base) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string' || !manifest.version) return null
  const version = manifest.version.replace(/^v/, '')
  return {
    version,
    tag: `v${version}`,
    product: productOf(manifest),
    date: typeof manifest.date === 'string' ? manifest.date : '',
    prerelease: Boolean(manifest.prerelease),
    notes: typeof manifest.notes === 'string' ? manifest.notes : '',
    notesUrl: notesLink(base, manifest.notesUrl) ?? '',
    assets: normalizeFiles(manifest.files, base),
  }
}

/**
 * versions.json を、新しい順の版の一覧に直す。最新は latest の指定 → 正式版 → 先頭の順で決める。
 * @param {any} index
 * @param {string} base
 */
export function normalizeIndex(index, base) {
  const list = Array.isArray(index?.versions) ? index.versions : []
  const all = list
    .filter((v) => v && typeof v.version === 'string' && v.version)
    .map((v) => {
      const version = v.version.replace(/^v/, '')
      return {
        version,
        tag: `v${version}`,
        product: productOf(v),
        date: typeof v.date === 'string' ? v.date : '',
        prerelease: Boolean(v.prerelease),
        manifestUrl: joinUrl(base, v.manifest ?? `releases/${version}/manifest.json`),
      }
    })
    .filter((v) => v.manifestUrl)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : compareVersions(b.version, a.version)))
  const wanted = typeof index?.latest === 'string' ? index.latest.replace(/^v/, '') : null
  const latest = all.find((v) => v.version === wanted) ?? all.find((v) => !v.prerelease) ?? all[0] ?? null
  return { latest, all }
}

/** 数字の並びとして版を比べる（日付が同じときの並べ替え用） */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/**
 * ファイルを枠に当てる。mac は universal でも両方の枠を埋める。
 * @param {ReturnType<typeof normalizeFiles>} assets
 * @param {{ os: string, arch: string, kinds: string[] }} slot
 */
export function assetForSlot(assets, slot) {
  for (const kind of slot.kinds) {
    const exact = assets.find((a) => a.info.os === slot.os && a.info.arch === slot.arch && a.info.kind === kind)
    if (exact) return exact
    if (slot.os === 'mac') {
      const universal = assets.find((a) => a.info.os === 'mac' && a.info.arch === 'universal' && a.info.kind === kind)
      if (universal) return universal
    }
  }
  return null
}

/**
 * 閲覧中の端末を推定する。CPU は分かる時だけ返す（Safari・Firefox の mac は分からない）。
 * @param {{ userAgent?: string, platform?: string, uaPlatform?: string, uaArch?: string, uaBitness?: string }} env
 * @returns {{ os: 'mac'|'win'|'linux'|null, arch: 'arm64'|'x64'|null, mobile: boolean }}
 */
export function detectPlatform(env = {}) {
  const ua = (env.userAgent ?? '').toLowerCase()
  const platform = (env.uaPlatform || env.platform || '').toLowerCase()
  const mobile = /iphone|ipad|ipod|android/.test(ua) || (platform.includes('mac') && /mobile/.test(ua))
  let os = null
  if (mobile) os = null
  else if (platform.includes('mac') || /mac os x|macintosh/.test(ua)) os = 'mac'
  else if (platform.includes('win') || /windows/.test(ua)) os = 'win'
  else if (platform.includes('linux') || /linux|x11|cros/.test(ua)) os = 'linux'

  let arch = null
  const uaArch = (env.uaArch ?? '').toLowerCase()
  if (uaArch === 'arm') arch = 'arm64'
  else if (uaArch === 'x86') arch = 'x64'
  else if (/arm64|aarch64/.test(ua)) arch = 'arm64'
  else if (os === 'win' && /win64|x64|wow64/.test(ua)) arch = 'x64'
  else if (os === 'linux' && /x86_64|amd64/.test(ua)) arch = 'x64'
  return { os, arch, mobile }
}

/**
 * 推定した端末に一番合う枠。mac の CPU が分からない時は Apple silicon を選ぶ（2020年以降の Mac の大半）。
 * @param {{ os: string|null, arch: string|null } | null} platform
 */
export function recommendedSlot(platform) {
  if (!platform?.os) return null
  if (platform.os === 'mac') return SLOTS.find((s) => s.id === (platform.arch === 'x64' ? 'mac-x64' : 'mac-arm64')) ?? null
  if (platform.os === 'win') return SLOTS.find((s) => s.id === (platform.arch === 'arm64' ? 'win-arm64' : 'win-x64')) ?? null
  return SLOTS.find((s) => s.id === 'linux-appimage') ?? null
}

export const OS_LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' }

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** @param {string} iso */
export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return ''
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
}

/**
 * リリースノート（Markdown）の先頭を、装飾を外した短い行の配列にする。
 * 表示は textContent で行う前提なので、HTML への変換はしない。
 * @param {string} body
 * @param {number} [maxLines]
 */
export function excerptNotes(body, maxLines = 8) {
  if (typeof body !== 'string') return []
  const lines = []
  let inCode = false
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const text = raw
      .replace(/<!--.*?-->/g, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (!text) continue
    // 未署名の回避手順など、1行が長い注意書きも切らずに読めるようにする
    lines.push(text.length > 280 ? `${text.slice(0, 279)}…` : text)
    if (lines.length >= maxLines) break
  }
  return lines
}
