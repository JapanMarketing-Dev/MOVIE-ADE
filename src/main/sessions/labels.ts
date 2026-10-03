/**
 * 一覧の整理（名前・アーカイブ・送った時刻）と、レビューの削除。
 *
 * 名前などは session.json ではなく label.json に置く。session.json が無い（分解の途中で落ちた）
 * レビューにも名前を付けたり、アーカイブしたりできるようにするため。
 */
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { ReviewLabelPatch } from '@shared/review'
import { isSessionId, reviewsRoots, sessionPaths, type SessionPaths } from './paths'

export interface SessionLabel {
  name?: string
  archived?: boolean
  sentAt?: string
}

/** 名前の長さの上限。一覧の見出しなので長い文は要らない */
const NAME_MAX = 120

/** 読めなければ空（＝名前なし・アーカイブなし・未送信） */
export async function readLabel(paths: SessionPaths): Promise<SessionLabel> {
  try {
    return sanitizeLabel(JSON.parse(await readFile(paths.labelJson, 'utf8')))
  } catch {
    // 名前を付けていないレビューには label.json が無い（想定内）
    return {}
  }
}

/** 壊れた値は捨てる（単体テストから使うため export） */
export function sanitizeLabel(raw: unknown): SessionLabel {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, NAME_MAX) : ''
  return {
    ...(name ? { name } : {}),
    ...(r.archived === true ? { archived: true } : {}),
    ...(typeof r.sentAt === 'string' && !Number.isNaN(Date.parse(r.sentAt)) ? { sentAt: r.sentAt } : {})
  }
}

/** 名前・アーカイブを変える。name に null か空文字を渡すと名前を外す */
export async function updateLabel(paths: SessionPaths, patch: ReviewLabelPatch & { sentAt?: string }): Promise<SessionLabel> {
  const current = await readLabel(paths)
  const next = sanitizeLabel({
    ...current,
    ...(patch.name !== undefined ? { name: patch.name ?? '' } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {})
  })
  await writeFile(paths.labelJson, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 消してよいレビューのフォルダを返す。だめなら理由を投げる。
 *
 * renderer から来た ID で rm -r するので、必ず `<project>/.ferret/reviews/<日時>`（古いものは `.ade-movie/reviews/<日時>`）の形で、
 * reviews の直下に収まることを確かめる（`..` や絶対パス、区切り文字を混ぜた ID を通さない）。
 */
export function deletableSessionDir(projectDir: string, id: string): string {
  if (!isSessionId(id)) throw new Error(`invalid review id: ${id}`)
  const dir = resolve(sessionPaths(projectDir, id).dir)
  const root = reviewsRoots(projectDir).map((r) => resolve(r)).find((r) => r === dirname(dir))
  if (!root) throw new Error(`review is outside the project: ${id}`)
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..') || rel.includes(sep) || rel !== id) throw new Error(`review is outside the project: ${id}`)
  return dir
}

/** レビューを1件消す（フォルダごと）。無ければ何もしない */
export async function deleteSession(projectDir: string, id: string): Promise<void> {
  const dir = deletableSessionDir(projectDir, id)
  // 消し済み（想定内）
  const s = await stat(dir).catch(() => null)
  if (!s) return
  if (!s.isDirectory()) throw new Error(`not a review folder: ${id}`)
  await rm(dir, { recursive: true, force: true })
}
