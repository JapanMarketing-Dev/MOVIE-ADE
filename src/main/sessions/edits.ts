/**
 * 確認画面での編集（要件 REV-2 / REV-3 / REV-5）。
 *
 * 編集は「操作の列」として session.json に残し、feedback.md はそこから再生成する
 * （設計 5章④「確認画面での編集結果は session.json に保存し、feedback.md を再生成する」）。
 * 元の指摘一覧は変えないので、編集を取り消したり順番を入れ替えたりできる。
 * 指摘の並べ替え（order）も操作の1つ。並べ替えたら finalizeItems は時刻順に並べ直さない（FeedbackDocument.customOrder）。
 */
import type { AssembleOptions } from '../pipeline/assemble'
import { finalizeItems, toPending } from '../pipeline/assemble'
import type { PendingItem } from '../pipeline/assemble'
import type { Event, FeedbackDocument, FrameRef, ItemStatus } from '../pipeline/types'
import { t } from '@shared/i18n'
import { applySubsetOrder } from '@shared/reorder'

export type ItemEdit =
  /** テキストを直す（REV-2） */
  | { kind: 'text'; id: string; title?: string; request?: string }
  /** 指摘を削除する（REV-2） */
  | { kind: 'delete'; id: string }
  /** 隣り合う指摘を結合する（REV-2）。先頭のIDに寄せる */
  | { kind: 'merge'; ids: string[] }
  /** 「要確認」を送信対象に含める／外す（REV-2 / 設計7章4） */
  | { kind: 'include'; id: string; include: boolean }
  /** 「要確認」の内容を確定させる（REV-2）。decided にすると既定で送信対象に入る */
  | { kind: 'status'; id: string; status: ItemStatus }
  /** 画像を前後の時刻のものへ差し替える（REV-3）。URL・要素・直前の操作も引き直す */
  | { kind: 'frames'; id: string; frameTimes: number[] }
  /** 全体への補足コメント（REV-5） */
  | { kind: 'note'; note: string }
  /** 指摘を並べ替える。ids は新しい並び（無い指摘はその位置のまま）。null で時刻順に戻す */
  | { kind: 'order'; ids: string[] | null }

interface ApplyEditsInput {
  /** 分解直後の指摘一覧（編集前の正本） */
  document: FeedbackDocument
  edits: ItemEdit[]
  /** 文脈を引き直すのに使う */
  events: Event[]
  /** 画像の差し替え先として選べる静止画 */
  frames: FrameRef[]
  options?: Partial<AssembleOptions>
}

interface ApplyEditsResult {
  document: FeedbackDocument
  /** 適用できなかった編集（IDが見つからないなど）。UIで知らせる */
  skipped: Array<{ edit: ItemEdit; reason: string }>
}

/** 編集を順に適用して、確認画面・feedback.md 用の指摘一覧を作り直す */
export function applyEdits(input: ApplyEditsInput): ApplyEditsResult {
  const frameTimes = new Set(input.frames.map((f) => f.t))
  const skipped: ApplyEditsResult['skipped'] = []

  let pending: PendingItem[] = input.document.items.map(toPending)
  let note = input.document.note
  /** 並べ替えた一覧か（それまでの編集で並べ替えていれば、その順を保つ） */
  let customOrder = input.document.customOrder === true

  const find = (id: string): PendingItem | undefined => pending.find((p) => p.id === id)

  for (const edit of input.edits) {
    switch (edit.kind) {
      case 'note':
        note = edit.note.trim() || undefined
        break

      case 'text': {
        const item = find(edit.id)
        if (!item) {
          skipped.push({ edit, reason: t('review.errors.skipped.notFound') })
          break
        }
        if (edit.title !== undefined) item.title = edit.title
        if (edit.request !== undefined) item.request = edit.request
        break
      }

      case 'delete': {
        const before = pending.length
        pending = pending.filter((p) => p.id !== edit.id)
        if (pending.length === before) skipped.push({ edit, reason: t('review.errors.skipped.notFound') })
        break
      }

      case 'include': {
        const item = find(edit.id)
        if (!item) {
          skipped.push({ edit, reason: t('review.errors.skipped.notFound') })
          break
        }
        item.include = edit.include
        break
      }

      case 'status': {
        const item = find(edit.id)
        if (!item) {
          skipped.push({ edit, reason: t('review.errors.skipped.notFound') })
          break
        }
        item.status = edit.status
        // 確定させたら送信対象に入れ、要確認へ戻したら外す（設計7章4）
        item.include = edit.status === 'decided'
        break
      }

      case 'frames': {
        const item = find(edit.id)
        if (!item) {
          skipped.push({ edit, reason: t('review.errors.skipped.notFound') })
          break
        }
        const valid = [...new Set(edit.frameTimes.filter((t) => frameTimes.has(t)))]
          .sort((a, b) => a - b)
          .slice(0, 3)
        if (valid.length === 0) {
          skipped.push({ edit, reason: t('review.errors.skipped.noFrame') })
          break
        }
        item.frameTimes = valid
        // 文脈（URL・要素・直前の操作）は finalizeItems が新しい画像の時刻から引き直す
        break
      }

      case 'order': {
        if (edit.ids === null) {
          customOrder = false
          break
        }
        // renderer から来た並び。知らない ID・重複は捨て、ids に無い指摘（追記・復元したもの）はその位置のまま
        if (!Array.isArray(edit.ids)) {
          skipped.push({ edit, reason: t('review.errors.skipped.notFound') })
          break
        }
        const byId = new Map(pending.map((p) => [p.id, p]))
        const subset = edit.ids.flatMap((id) => (typeof id === 'string' && byId.has(id) ? [byId.get(id)!] : []))
        pending = applySubsetOrder(pending, subset)
        customOrder = true
        break
      }

      case 'merge': {
        const targets = edit.ids.map((id) => find(id)).filter((x): x is PendingItem => x !== undefined)
        if (targets.length < 2) {
          skipped.push({ edit, reason: t('review.errors.skipped.mergeNeedsTwo') })
          break
        }
        const merged = mergeItems(targets)
        const first = targets[0]!
        pending = pending.filter((p) => !edit.ids.includes(p.id) || p.id === first.id)
        pending = pending.map((p) => (p.id === first.id ? merged : p))
        break
      }
    }
  }

  const document: FeedbackDocument = {
    ...input.document,
    items: finalizeItems(pending, input.events, input.options, customOrder),
    ...(note !== undefined ? { note } : {}),
    ...(customOrder ? { customOrder: true as const } : {})
  }
  if (note === undefined) delete document.note
  if (!customOrder) delete document.customOrder
  return { document, skipped }
}

/**
 * 複数の指摘を1件にまとめる。
 * 見出しは先頭のものを使い、要望・引用・画像・書き込みを束ねる。
 * どれかが「要確認」なら、まとめた結果も「要確認」にする（勝手に確定させない）。
 */
function mergeItems(items: PendingItem[]): PendingItem {
  const sorted = [...items].sort((a, b) => a.t - b.t)
  const head = sorted[0]!
  const requests = sorted.map((i) => i.request.trim()).filter((r) => r.length > 0)
  const needsCheck = sorted.some((i) => i.status === 'needs_check')

  const quotes = dedupeBy(
    sorted.flatMap((i) => i.quotes).sort((a, b) => a.t - b.t),
    (q) => `${q.t}:${q.text}`
  )

  return {
    id: head.id,
    t: head.t,
    title: head.title,
    request: requests.join(' / '),
    status: needsCheck ? 'needs_check' : 'decided',
    quotes,
    frameTimes: [...new Set(sorted.flatMap((i) => i.frameTimes))].sort((a, b) => a - b).slice(0, 3),
    annotationIds: [...new Set(sorted.flatMap((i) => i.annotationIds))],
    draftIds: [...new Set(sorted.flatMap((i) => i.draftIds))],
    include: needsCheck ? false : sorted.some((i) => i.include)
  }
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

/**
 * 画像の差し替え候補（REV-3「前後の時刻のものへ差し替えられる」）。
 * いま選んでいる時刻の前後から、近い順に返す。
 */
export function frameCandidates(
  frames: FrameRef[],
  current: number,
  count = 5
): FrameRef[] {
  return [...frames]
    .sort((a, b) => Math.abs(a.t - current) - Math.abs(b.t - current))
    .slice(0, count)
    .sort((a, b) => a.t - b.t)
}
