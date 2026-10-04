import type { DroppedEntry } from '@shared/externalDrop'
import { markdownMediaKind, relativeMediaPath, type MarkdownMediaKind } from '@shared/markdownMedia'

/**
 * Markdown のファイルへ画像・動画を落として埋め込む（ソースとプレビューの両方）。
 *
 * 中央のペインのドロップは App.tsx の useExternalDrop が捕捉の段階で受ける（中のエディタの既定の処理へは渡さない）。
 * そこで、落とした位置に Markdown のエディタがあれば、画像・動画だけをここへ回して埋め込み、残りは今までどおりタブで開く。
 * エディタ（FileEditor のソース・RichMarkdownEditor のプレビュー）は、出ている間だけ registerMarkdownDropTarget で名乗り出る。
 */

export interface DropPoint {
  x: number
  y: number
}

/** 埋め込む1つ。link は Markdown のファイルからの相対パス（符号化の前） */
export interface MediaEmbed {
  kind: MarkdownMediaKind
  link: string
}

export interface MarkdownDropTarget {
  /** Markdown のファイルのプロジェクトからの相対パス */
  path: string
  /** 落とせる範囲（エディタの本体）。隠れているときは null か大きさ 0 */
  element: () => HTMLElement | null
  /** 落とした位置（無ければ今のカーソル）へ入れる */
  insert: (media: readonly MediaEmbed[], point: DropPoint) => void
}

const targets = new Set<MarkdownDropTarget>()

export function registerMarkdownDropTarget(target: MarkdownDropTarget): () => void {
  targets.add(target)
  return () => { targets.delete(target) }
}

function contains(element: HTMLElement | null, point: DropPoint): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}

/** その位置にある Markdown のエディタ。無ければ null */
export function markdownDropTargetAt(point: DropPoint | undefined): MarkdownDropTarget | null {
  if (!point) return null
  for (const target of targets) if (contains(target.element(), point)) return target
  return null
}

/** 外から落としたもののうち、埋め込む画像・動画（中のもの・外のもの）と、それ以外（今までどおり開く） */
export interface MediaDropPlan {
  /** 落とした順。inside は relPath（コピーしない）、outside は絶対パス（コピーしてからつなぐ） */
  media: Array<{ kind: MarkdownMediaKind; relPath: string } | { kind: MarkdownMediaKind; outsidePath: string }>
  rest: DroppedEntry[]
}

export function planMediaDrop(entries: readonly DroppedEntry[]): MediaDropPlan {
  const media: MediaDropPlan['media'] = []
  const rest: DroppedEntry[] = []
  for (const entry of entries) {
    const kind = entry.kind === 'file' ? markdownMediaKind(entry.path) : null
    if (!kind) rest.push(entry)
    else if (entry.relPath) media.push({ kind, relPath: entry.relPath })
    else media.push({ kind, outsidePath: entry.path })
  }
  return { media, rest }
}

/** ファイルツリーから落とした相対パスのうち、埋め込む画像・動画と、それ以外 */
export function planTreeMediaDrop(relPaths: readonly string[]): { media: Array<{ kind: MarkdownMediaKind; relPath: string }>; rest: string[] } {
  const media: Array<{ kind: MarkdownMediaKind; relPath: string }> = []
  const rest: string[] = []
  for (const relPath of relPaths) {
    const kind = markdownMediaKind(relPath)
    if (kind) media.push({ kind, relPath })
    else rest.push(relPath)
  }
  return { media, rest }
}

/**
 * 埋め込む。外のものは main がコピーしてから（fs:importMedia）、どれも Markdown のファイルからの相対パスでつなぐ。
 * 失敗は投げる（呼び出し元がトーストに出す）
 */
export async function embedMedia(target: MarkdownDropTarget, media: MediaDropPlan['media'], point: DropPoint, importMedia: (markdownRel: string, paths: string[]) => Promise<string[]>): Promise<void> {
  if (media.length === 0) return
  const outside = media.flatMap((m) => ('outsidePath' in m ? [m.outsidePath] : []))
  const copied = outside.length > 0 ? await importMedia(target.path, outside) : []
  if (copied.length !== outside.length) throw new Error('fs:importMedia returned an unexpected result')
  let next = 0
  const embeds = media.map((m): MediaEmbed => ({ kind: m.kind, link: relativeMediaPath(target.path, 'relPath' in m ? m.relPath : copied[next++]!) }))
  target.insert(embeds, point)
}
