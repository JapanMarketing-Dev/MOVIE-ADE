import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { MAX_DROPPED_PATHS, type DroppedEntry } from '@shared/externalDrop'
import { relativeInside } from './files'

/**
 * 外からウインドウへ落とされたファイル・フォルダのパスを確かめて覚える。
 *
 * パスは preload が webUtils.getPathForFile で File から取り出したものだけが届く（drop:inspect は
 * renderer の window.ade.invoke の許可リストに入れず、preload の inspectDrop からだけ呼ぶ）。
 * それでも renderer から来た値なので、形・存在・種類（ファイル / フォルダ）をここで確かめる。
 *
 * 確かめたパスはしばらく覚え、そのパスを使う操作（プロジェクトとして追加・ツリーへの取り込みなど）は
 * 「最近落とされたもの」かを isRecentlyDropped で確かめてから使う。プロジェクトの外を書き込み先にはしない。
 */

/** 落としてから操作を終えるまでの猶予 */
const REMEMBER_MS = 10 * 60_000
const MAX_PATH_LENGTH = 4096

/** 覚えているパス（比べる鍵 → 期限） */
const recent = new Map<string, number>()

function keyOf(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved
}

function forgetExpired(now: number): void {
  for (const [key, until] of recent) if (until <= now) recent.delete(key)
}

/** renderer から来た値のうち、絶対パスの形をしたものだけ（NUL・長すぎるもの・重複は除く） */
export function sanitizeDroppedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of paths.slice(0, MAX_DROPPED_PATHS)) {
    if (typeof p !== 'string' || !p || p.length > MAX_PATH_LENGTH || p.includes('\0') || !isAbsolute(p)) continue
    const key = keyOf(p)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 * 落とされたパスを確かめる。無いもの・ファイルでもフォルダでもないもの（デバイスなど）は除く。
 * root（開いているプロジェクト）の中なら、実体（realpath）どうしで比べた相対パスを添える
 */
export async function inspectDropped(paths: unknown, root: string | null, now = Date.now()): Promise<DroppedEntry[]> {
  forgetExpired(now)
  const realRoot = root ? await realpath(root).catch(() => null) : null
  const entries = await Promise.all(sanitizeDroppedPaths(paths).map(async (path): Promise<DroppedEntry | null> => {
    try {
      const info = await stat(path)
      const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
      if (!kind) return null
      const relPath = realRoot ? relativeInside(realRoot, await realpath(path)) : null
      return { path, kind, relPath: relPath === '' ? null : relPath }
    } catch {
      // 無い・読めない（想定内。そのパスだけ除く）
      return null
    }
  }))
  const found = entries.filter((e): e is DroppedEntry => e !== null)
  for (const entry of found) recent.set(keyOf(entry.path), now + REMEMBER_MS)
  return found
}

/** そのパスが最近落とされ、inspectDropped で確かめたものか */
export function isRecentlyDropped(path: unknown, now = Date.now()): path is string {
  if (typeof path !== 'string' || !path) return false
  const until = recent.get(keyOf(path))
  return until !== undefined && until > now
}

/** 最近落とされたフォルダなら、その絶対パス。そうでなければ null（追加の前にいまもフォルダかを確かめる） */
export async function droppedFolder(path: unknown, now = Date.now()): Promise<string | null> {
  if (!isRecentlyDropped(path, now)) return null
  try {
    return (await stat(path)).isDirectory() ? resolve(path) : null
  } catch {
    return null
  }
}

/** テスト用: 覚えているものを忘れる */
export function clearDroppedForTest(): void {
  recent.clear()
}
