/**
 * ドラッグ＆ドロップ・キーボードでの並べ替え（プロジェクトの一覧と、レビューの指摘）の純粋な関数。
 * 一覧の一部だけが見えている（絞り込み中）ときも、見えている中での相対位置で全体の順を決め、見えないものの位置は保つ。
 */

/** 落とす位置。対象の行の上（前）か下（後ろ）か */
export type DropPosition = 'before' | 'after'

/** 行の中のマウスの高さから、上半分なら前・下半分なら後ろ */
export function dropPositionAt(offsetY: number, height: number): DropPosition {
  return offsetY < height / 2 ? 'before' : 'after'
}

/**
 * subset（全体の一部の並び）を、全体の中でそれらが占めていた位置に順に入れ直す。
 * subset に無いものはその位置のまま。subset のうち全体に無いもの・重複は捨てる
 */
export function applySubsetOrder<T>(all: readonly T[], subset: readonly T[]): T[] {
  const members = new Set(all)
  const seen = new Set<T>()
  const ordered = subset.filter((x) => members.has(x) && !seen.has(x) && (seen.add(x), true))
  const picked = new Set(ordered)
  let next = 0
  return all.map((x) => (picked.has(x) ? ordered[next++]! : x))
}

/**
 * 見えている行（visible）の中で moving を target の前／後ろへ動かし、全体（all）の新しい並びを返す。
 * 動かないとき（自分の上に落とした・見つからない）は null
 */
export function moveAmongVisible<T>(all: readonly T[], visible: readonly T[], moving: T, target: T, position: DropPosition): T[] | null {
  if (moving === target || !visible.includes(moving) || !visible.includes(target)) return null
  const rest = visible.filter((x) => x !== moving)
  const at = rest.indexOf(target) + (position === 'after' ? 1 : 0)
  const reordered = [...rest.slice(0, at), moving, ...rest.slice(at)]
  if (reordered.every((x, i) => x === visible[i])) return null
  return applySubsetOrder(all, reordered)
}

/**
 * キーボードでの1つ上／下（delta = -1 / +1）。見えている行の中の隣と入れ替える。端なら null。
 * within を渡すと、その中（同じ対象の指摘など）の隣とだけ入れ替える
 */
export function stepAmongVisible<T>(all: readonly T[], visible: readonly T[], moving: T, delta: -1 | 1, within?: (x: T) => boolean): T[] | null {
  const candidates = within ? visible.filter((x) => x === moving || within(x)) : visible
  const index = candidates.indexOf(moving)
  const neighbor = candidates[index + delta]
  if (index < 0 || neighbor === undefined) return null
  return moveAmongVisible(all, visible, moving, neighbor, delta < 0 ? 'before' : 'after')
}
