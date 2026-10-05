import type { ReviewVerdict } from './findingProgress'

/**
 * 「BEFORE と AFTER を大きく比べる」画面の前後の移動（ReviewFindings の比べる画面が使う。純粋な関数）。
 * 並びは一覧の表示順。確認待ち（human_review・送る指摘）から開いたら確認待ちの中を、
 * そうでなければ AFTER のある指摘の中を移動する。端で止まる（回り込まない）
 */
export interface CompareNav {
  /** 移動する指摘の並び（表示順） */
  list: string[]
  /** list の中の今の位置（0 から）。今の指摘が list に無ければ -1 */
  index: number
  prev: string | null
  next: string | null
  /** 確認待ちの中を移動しているか（位置「2 / 5」は確認待ちの中の位置） */
  awaiting: boolean
}

export function compareNav(order: readonly string[], current: string, isAwaiting: (id: string) => boolean, hasAfter: (id: string) => boolean): CompareNav {
  const awaiting = isAwaiting(current)
  const list = order.filter((id) => id === current || (awaiting ? isAwaiting(id) : hasAfter(id)))
  const index = list.indexOf(current)
  return {
    list,
    index,
    prev: index > 0 ? list[index - 1]! : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1]! : null,
    awaiting
  }
}

/**
 * OK / NG / コメントを付けたあとに出す指摘。今の指摘より後ろの確認待ちを先に、無ければ先頭へ戻って探す（今の指摘は除く）。
 * 判定の前の表示順で決める（「確認待ちを上に」だと、判定した指摘は並びの下へ動くため）。
 * どこにも無ければ、OK・NG は 'done'（確認待ちはもう無い）、コメントは今の指摘が確認待ちのまま残るので 'stay'
 */
export type AfterVerdict = { kind: 'go'; id: string } | { kind: 'stay' } | { kind: 'done' }

export function afterVerdict(order: readonly string[], current: string, isAwaiting: (id: string) => boolean, verdict: ReviewVerdict): AfterVerdict {
  const at = order.indexOf(current)
  const rotated = at < 0 ? order : [...order.slice(at + 1), ...order.slice(0, at)]
  const id = rotated.find((other) => other !== current && isAwaiting(other))
  if (id) return { kind: 'go', id }
  return verdict === 'comment' ? { kind: 'stay' } : { kind: 'done' }
}
