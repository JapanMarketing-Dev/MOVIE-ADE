/**
 * エディタで文字として開けないファイル（画像・動画・音声・PDF・その他のバイナリ）の見せ方の規則。
 * main（ade-media://project/ で中身を返す）と renderer（ビューアを選ぶ）で共有する。
 *
 *   ade-media://project/<プロジェクトからの相対パス>   … プロジェクトのファイルの中身（下の拡張子だけ）
 *
 * 相対パスは区切りごとに符号化する。standard なスキームは先頭の区切りをホスト名として小文字にするため、
 * パスはホスト（project）の後ろに入れる（ade-preview:// と同じ形）。
 * 中身を返す前の検査（プロジェクトの外・外を指すリンク・普通のファイルでないもの）は main が行う。
 */

const MEDIA_SCHEME = 'ade-media'
const PROJECT_MEDIA_HOST = 'project'

type MediaViewerKind = 'image' | 'video' | 'audio' | 'pdf'
/** エディタの中の見せ方。office は Word・Excel・PowerPoint（@shared/office が HTML にする）。binary は大きさと先頭の16進数だけ */
export type FileViewerKind = MediaViewerKind | 'office' | 'binary'

/** 中身を返してよい拡張子と Content-Type。ここに無いもの（html・js など）は返さない */
const MEDIA_TYPES: Record<string, { kind: MediaViewerKind; type: string }> = {
  '.png': { kind: 'image', type: 'image/png' },
  '.apng': { kind: 'image', type: 'image/apng' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.gif': { kind: 'image', type: 'image/gif' },
  '.webp': { kind: 'image', type: 'image/webp' },
  '.avif': { kind: 'image', type: 'image/avif' },
  '.bmp': { kind: 'image', type: 'image/bmp' },
  '.ico': { kind: 'image', type: 'image/x-icon' },
  '.cur': { kind: 'image', type: 'image/x-icon' },
  '.svg': { kind: 'image', type: 'image/svg+xml' },
  '.mp4': { kind: 'video', type: 'video/mp4' },
  '.m4v': { kind: 'video', type: 'video/mp4' },
  '.webm': { kind: 'video', type: 'video/webm' },
  '.mov': { kind: 'video', type: 'video/quicktime' },
  '.ogv': { kind: 'video', type: 'video/ogg' },
  '.mp3': { kind: 'audio', type: 'audio/mpeg' },
  '.m4a': { kind: 'audio', type: 'audio/mp4' },
  '.aac': { kind: 'audio', type: 'audio/aac' },
  '.wav': { kind: 'audio', type: 'audio/wav' },
  '.ogg': { kind: 'audio', type: 'audio/ogg' },
  '.oga': { kind: 'audio', type: 'audio/ogg' },
  '.opus': { kind: 'audio', type: 'audio/ogg' },
  '.flac': { kind: 'audio', type: 'audio/flac' },
  '.pdf': { kind: 'pdf', type: 'application/pdf' }
}

/**
 * 表示する大きさの上限。画像と PDF は全体を読み込んで描くので絞る（それを超えたら binary の表示にする）。
 * 動画・音声は Range で少しずつ読むので上限を置かない。
 */
export const MAX_VIEWER_BYTES: Record<MediaViewerKind, number> = {
  image: 50 * 1024 * 1024,
  pdf: 200 * 1024 * 1024,
  video: Number.POSITIVE_INFINITY,
  audio: Number.POSITIVE_INFINITY
}

/** binary の表示で見せる先頭のバイト数 */
export const BINARY_HEAD_BYTES = 512

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** 拡張子から見せ方と Content-Type。画像・動画・音声・PDF でなければ null */
export function mediaTypeOf(path: string): { kind: MediaViewerKind; type: string } | null {
  return MEDIA_TYPES[extensionOf(path)] ?? null
}

export function mediaKindOf(path: string): MediaViewerKind | null {
  return mediaTypeOf(path)?.kind ?? null
}

/** SVG は文字のファイルでもある（「コードとして開く」を出す） */
export function isSvgPath(path: string): boolean {
  return extensionOf(path) === '.svg'
}

/** 相対パス → 中身の URL。version を付けると、書き換わったときに取り直させられる */
export function projectMediaUrl(path: string, version?: number): string {
  const base = `${MEDIA_SCHEME}://${PROJECT_MEDIA_HOST}/${path.split('/').map(encodeURIComponent).join('/')}`
  return version ? `${base}?v=${version}` : base
}

/** 中身の URL → 相対パス。違う形・壊れた符号・`.` `..` の区切りは null（クエリ・ハッシュは見ない） */
export function projectMediaPathFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== PROJECT_MEDIA_HOST) return null
  let segments: string[]
  try {
    segments = parsed.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  // 符号化した `..` や区切り（%2F・%5C）で外へ出る形は、main の検査より前に断る
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) return null
  return segments.join('/')
}

/**
 * 外のアプリ（OS の既定）で開くと、そのまま実行されうるもの。エディタからは開かせず「Finder で表示」だけにする。
 * Agent やクローンしたリポジトリが置いたファイルを、ワンクリックで実行させないため。
 */
const RISKY_TO_OPEN = new Set([
  '.app', '.command', '.tool', '.terminal', '.sh', '.zsh', '.bash', '.csh', '.ksh', '.fish', '.pl', '.py', '.rb', '.js', '.mjs', '.cjs',
  '.scpt', '.scptd', '.applescript', '.workflow', '.action', '.pkg', '.mpkg', '.dmg', '.jar', '.webloc', '.inetloc', '.fileloc',
  '.url', '.desktop', '.appimage', '.run', '.deb', '.rpm', '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf',
  '.wsh', '.msi', '.msix', '.appx', '.lnk', '.scr', '.hta', '.cpl', '.reg', '.dll', '.so', '.dylib', '.bin', '.prefpane',
  '.kext', '.mobileconfig', '.osax', '.plugin', '.docm', '.xlsm', '.pptm', '.html', '.htm', '.xhtml', '.svg'
])

export function isRiskyToOpenExternally(path: string): boolean {
  const ext = extensionOf(path)
  // 拡張子の無いファイルは実行ファイルのことが多い
  return ext === '' || RISKY_TO_OPEN.has(ext)
}

/** fs:inspect の結果（binary の表示に使う） */
export interface FsFileInfo {
  path: string
  size: number
  mtimeMs: number
  /** 先頭 BINARY_HEAD_BYTES バイト */
  head: Uint8Array
}

/** 16進数の表示の1行（オフセット・16バイト・文字） */
export function formatHexDump(bytes: Uint8Array, offset = 0): string[] {
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16)
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'))
    const left = hex.slice(0, 8).join(' ')
    const right = hex.slice(8).join(' ')
    const text = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${(offset + i).toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${text}|`)
  }
  return lines
}

/** バイト数を読みやすく（1 KB = 1024 B） */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
