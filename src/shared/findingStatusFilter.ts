/**
 * Findings を進み具合（未対応・対応中・確認待ち・完了）で絞り込む。
 *
 * 持つのは「隠す進み具合」の一覧。空ならすべて出す。チップを押すとその進み具合の表示と非表示が切り替わり、
 * 「〜だけ表示」でそれ以外をすべて隠す。選んだものはこの端末に保存して、次に開いたときも残す。
 */
import { progressOf, type FindingProgress, type ProgressMap } from './findingProgress'

/** チップの並び。流れの順（未対応 → 対応中 → 確認待ち → 完了） */
export const FINDING_STATUSES: readonly FindingProgress[] = ['todo', 'in_progress', 'human_review', 'done']

export type HiddenStatuses = readonly FindingProgress[]

/** 保存した値を読む。知らない値・重複・壊れた形は捨てる。全部を隠した状態は残さない（何も出ない一覧にしない） */
export function sanitizeHiddenStatuses(raw: unknown): FindingProgress[] {
  if (!Array.isArray(raw)) return []
  const hidden = FINDING_STATUSES.filter((status) => raw.includes(status))
  return hidden.length === FINDING_STATUSES.length ? [] : hidden
}

export function isStatusShown(hidden: HiddenStatuses, status: FindingProgress): boolean {
  return !hidden.includes(status)
}

/** 1つの表示と非表示を切り替える。最後に残った1つを隠そうとしたときは、すべて表示に戻す */
export function toggleStatus(hidden: HiddenStatuses, status: FindingProgress): FindingProgress[] {
  const next = hidden.includes(status) ? hidden.filter((s) => s !== status) : [...hidden, status]
  return sanitizeHiddenStatuses(next)
}

/** その進み具合だけを出す */
export function onlyStatus(status: FindingProgress): FindingProgress[] {
  return FINDING_STATUSES.filter((s) => s !== status)
}

/** 進み具合ごとの件数（送らない指摘も含め、一覧に並ぶものすべて） */
export function countByStatus(items: ReadonlyArray<{ id: string }>, map: ProgressMap | undefined): Record<FindingProgress, number> {
  const count: Record<FindingProgress, number> = { todo: 0, in_progress: 0, human_review: 0, done: 0 }
  for (const item of items) count[progressOf(map, item.id)]++
  return count
}

/**
 * 進み具合の順（未対応 → 対応中 → 確認待ち → 完了）に並べた ID。同じ進み具合の中は今の並びのまま。
 * 指摘の並び順「進み具合の順」で、この並びを手動の順として保存する
 */
export function sortByStatus(ids: readonly string[], map: ProgressMap | undefined): string[] {
  const rank = (id: string) => FINDING_STATUSES.indexOf(progressOf(map, id))
  return ids.map((id, index) => ({ id, index })).sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index).map((x) => x.id)
}
