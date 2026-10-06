/**
 * AFTER のスクリーンショット（Agent が撮って、レビューのフォルダに置いたもの）を画面へ出すための読み込み。
 *
 * progress.json の after は Agent が書くので、どこを指していても安全なように確かめる:
 *   - @shared/afterShot の sanitizeAfterPath を通った相対パスだけ（.. や絶対パスは捨てる）
 *   - 実体（シンボリックリンクをたどった先）がレビューのフォルダの中にあること
 *   - 画像のファイルで、大きすぎないこと
 * 画面へは ade-media://review/<id>/file/<相対パス> で出す（index.ts。読むのは readFileNoFollow）。任意のファイルは読ませない。
 *
 * Electron に依存させない（単体テストで一時フォルダを使うため）。
 */
import { lstat, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { sanitizeAfterPath } from '@shared/afterShot'
import { assertContained } from './sessions/containment'
import { openContained } from './containedFile'

/** 画面に出す AFTER の大きさの上限。これより大きいファイルは出さない（Agent の撮り間違いで巨大な画像になることがある） */
const AFTER_MAX_BYTES = 20 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export function afterContentType(path: string): string {
  return CONTENT_TYPES[path.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * レビューのフォルダの中の AFTER の実体のパス。外を指す・無い・画像でない・大きすぎるなら null。
 * 読み取りの失敗（消された・権限）も null（画面は「AFTER がありません」を出すだけ）
 */
export async function resolveAfterFile(reviewDir: string, raw: unknown): Promise<string | null> {
  const rel = sanitizeAfterPath(raw)
  if (!rel) return null
  try {
    const root = await realpath(reviewDir)
    const target = join(reviewDir, ...rel.split('/'))
    // 途中のフォルダ（after/ など）がリンクでないこと・実体が外に無いことを、保存先と同じ部品で確かめる（投げたら読まない）
    assertContained(reviewDir, target)
    // 末端がシンボリックリンクなら、指す先がフォルダの中でも読まない（Agent 側が差し替えられるため）
    if ((await lstat(target)).isSymbolicLink()) return null
    const file = await realpath(target)
    const inside = relative(root, file)
    if (!inside || inside.startsWith('..') || inside.startsWith(sep) || /^[A-Za-z]:/.test(inside)) return null
    const info = await stat(file)
    return info.isFile() && info.size > 0 && info.size <= AFTER_MAX_BYTES ? file : null
  } catch {
    // まだ撮っていない・消された・読めない（想定内）
    return null
  }
}

/**
 * resolveAfterFile で確かめたファイルを読む（security-7 [13]）。確かめた文字列のパスを開き直すと、そのあいだに途中のフォルダを
 * 差し替えて外のファイルを読ませられるので、開いた fd がレビューのフォルダの中の実体と同じかを確かめてから、その fd から読む。
 * 普通のファイルでない・大きすぎる・確かめられなければ null
 */
export async function readAfterFile(reviewDir: string, file: string): Promise<Buffer | null> {
  const handle = await openContained(reviewDir, file, 'read').catch(() => null)
  if (!handle) return null
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > AFTER_MAX_BYTES) return null
    const bytes = Buffer.alloc(info.size)
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return bytes.subarray(0, read)
  } catch {
    // 読んでいる途中で消えた（想定内）
    return null
  } finally {
    await handle.close()
  }
}
