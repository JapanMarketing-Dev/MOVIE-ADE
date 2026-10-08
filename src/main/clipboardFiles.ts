/**
 * ファイルツリーの貼り付け（⌘V / Ctrl+V）で、OS のクリップボードにあるファイル・画像をプロジェクトへ取り込む。
 *
 * - Finder・エクスプローラー・ファイルマネージャーでコピーしたファイル（動画・画像・フォルダも）は、そのパスを main が読み、
 *   外から落としたときと同じ取り込み（fileOps.ts の importEntries。測った実体だけを、写しながら上限で止める）でコピーする
 * - スクリーンショットなど画像そのもの（ファイルでない）は PNG にして「pasted-<日時>.png」で置く
 * - クリップボードの中身・元のパスは renderer へ返さない（security-7 [1]）。返すのは作ったものの相対パスだけ。
 *   呼べるのは利用者が貼り付けのキーを押した直後の1回だけ（index.ts の gestures）
 *
 * 読み方の部分は Electron に依存させない（単体テストで OS ごとの形を確かめる）。
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContained } from './containedFile'
import { resolveInside } from './files'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'

/** 一度に取り込む数の上限（importEntries と同じ考え。多すぎる貼り付けは断る） */
const MAX_CLIPBOARD_FILES = 200
/** 貼り付けた画像の大きさの上限 */
export const MAX_PASTED_IMAGE_BYTES = 50 * 1024 * 1024

/** macOS の NSFilenamesPboardType（plist の <array><string>/path</string>…）から絶対パス */
export function pathsFromFilenamesPlist(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<string>([^<]*)<\/string>/g)) {
    const path = m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    if (path.startsWith('/')) out.push(path)
  }
  return out
}

/** text/uri-list・x-special/gnome-copied-files（1行目が copy / cut）・public.file-url の file:// から絶対パス */
export function pathsFromUriList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('file://')) continue
    try {
      out.push(fileURLToPath(line))
    } catch {
      // 別のホストの file:// など（想定内。取り込まない）
    }
  }
  return out
}

/** Windows の FileNameW（UTF-16LE、NUL 終わり）から絶対パス */
export function pathFromFileNameW(buffer: Buffer): string[] {
  const text = buffer.toString('utf16le').replace(/\0[\s\S]*$/, '')
  return /^[A-Za-z]:\\|^\\\\/.test(text) ? [text] : []
}

/** Electron の clipboard の read() が返す1件（W3C の ClipboardItem と同じ形。テストでは偽物を渡す） */
export interface ClipboardItemLike {
  readonly types: readonly string[]
  getType(type: string): Promise<unknown>
}
export interface ClipboardLike {
  read(): Promise<readonly ClipboardItemLike[]>
}

async function blobText(value: unknown): Promise<string> {
  if (typeof value === 'string') return value
  if (value && typeof (value as Blob).text === 'function') return (value as Blob).text()
  return ''
}

async function blobBytes(value: unknown): Promise<Buffer> {
  if (value && typeof (value as Blob).arrayBuffer === 'function') return Buffer.from(await (value as Blob).arrayBuffer())
  return Buffer.alloc(0)
}

/** OS の形式名（electron application/osclipboard;format="…"）の … の部分。ふつうの MIME ならそのまま */
function formatName(type: string): string {
  return /format="([^"]*)"/.exec(type)?.[1] ?? type
}

export type ClipboardPaste =
  | { kind: 'files'; paths: string[] }
  | { kind: 'image'; bytes: Buffer; ext: 'png' | 'jpg' | 'gif' | 'webp' }
  | { kind: 'none' }

const IMAGE_EXT: Record<string, 'png' | 'jpg' | 'gif' | 'webp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * クリップボードから、取り込むもの（ファイルの絶対パス、無ければ画像）を読む。
 * ファイルは text/uri-list（Chromium が OS ごとの形をこれにそろえる）を先に見て、無ければ OS の形
 * （macOS の NSFilenamesPboardType・Windows の FileNameW・GNOME の x-special/gnome-copied-files）を見る
 */
export async function readClipboardPaste(cb: ClipboardLike): Promise<ClipboardPaste> {
  const items = await cb.read()
  const paths: string[] = []
  const tryType = async (item: ClipboardItemLike, type: string, parse: (value: unknown) => Promise<string[]>) => {
    try {
      paths.push(...(await parse(await item.getType(type))))
    } catch {
      // その形式が読めない（想定内。ほかの形式を見る）
    }
  }
  for (const item of items) {
    for (const type of item.types) {
      if (type === 'text/uri-list') await tryType(item, type, async (v) => pathsFromUriList(await blobText(v)))
    }
  }
  if (paths.length === 0) {
    for (const item of items) {
      for (const type of item.types) {
        const name = formatName(type)
        if (name === 'NSFilenamesPboardType') await tryType(item, type, async (v) => pathsFromFilenamesPlist(await blobText(v)))
        else if (name === 'FileNameW') await tryType(item, type, async (v) => pathFromFileNameW(await blobBytes(v)))
        else if (name === 'x-special/gnome-copied-files') await tryType(item, type, async (v) => pathsFromUriList(await blobText(v)))
      }
    }
  }
  const unique = [...new Set(paths.filter((p) => isAbsolute(p) && !p.includes('\0')))]
  if (unique.length > MAX_CLIPBOARD_FILES) throw new UserFacingError(t('fileExplorer.pasteTooMany', { n: MAX_CLIPBOARD_FILES }))
  if (unique.length > 0) return { kind: 'files', paths: unique }
  for (const item of items) {
    const type = item.types.find((ty) => ty in IMAGE_EXT)
    if (!type) continue
    try {
      const bytes = await blobBytes(await item.getType(type))
      if (bytes.length > 0) return { kind: 'image', bytes, ext: IMAGE_EXT[type]! }
    } catch {
      // 読めない画像（想定内）
    }
  }
  return { kind: 'none' }
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** 画像のバイト列を destRel のフォルダに「pasted-<日時>.<ext>」で置く。同じ名前があれば -2, -3… を付ける。作った相対パス */
export async function writePastedImage(root: string, destRel: string, bytes: Buffer, ext = 'png', now = new Date()): Promise<string> {
  if (bytes.length === 0 || bytes.length > MAX_PASTED_IMAGE_BYTES) throw new UserFacingError(t('fileExplorer.pasteImageTooLarge'))
  const dir = await resolveInside(root, destRel)
  const base = `pasted-${stamp(now)}`
  for (let i = 1; i <= 100; i += 1) {
    const name = i === 1 ? `${base}.${ext}` : `${base}-${i}.${ext}`
    let handle
    try {
      handle = await createContained(root, join(dir, name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    return destRel ? `${destRel}/${name}` : name
  }
  throw new UserFacingError(t('fileExplorer.pasteImageTooLarge'))
}

/** ターミナルへの貼り付けで写す先（プロジェクトの中。.ferret/ は git の対象外。sessions/gitexclude.ts） */
export const TERMINAL_PASTE_DIR = '.ferret/pasted'

/**
 * ターミナルへの貼り付け（⌘V / Ctrl+V）で、クリップボードのファイル・画像（スクリーンショット・動画など）を Agent に渡せるようにする。
 * ファイルはプロジェクトの .ferret/pasted/ に写し、画像は pasted-<日時>.png で置く。返すのは作ったものの絶対パスだけ
 * （クリップボードの中身・元のパスは renderer へ返さない。security-7 [1]）。ファイルも画像も無ければ null（ふつうの文字の貼り付け）
 */
export async function pasteClipboardForTerminal(
  root: string,
  cb: ClipboardLike,
  importFiles: (paths: string[], destRel: string) => Promise<string[]>
): Promise<string[] | null> {
  const found = await readClipboardPaste(cb)
  if (found.kind === 'none') return null
  await mkdir(join(root, ...TERMINAL_PASTE_DIR.split('/')), { recursive: true })
  const created = found.kind === 'files'
    ? await importFiles(found.paths, TERMINAL_PASTE_DIR)
    : [await writePastedImage(root, TERMINAL_PASTE_DIR, found.bytes, found.ext)]
  return Promise.all(created.map(async (rel) => resolveInside(root, rel)))
}
