import { describe, expect, it } from 'vitest'
import { FINDING_STATUSES, countByStatus, isStatusShown, onlyStatus, sanitizeHiddenStatuses, reviewFirst, selectStatus, toggleStatus } from '../../src/shared/findingStatusFilter'
import type { ProgressMap } from '../../src/shared/findingProgress'

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const progress: ProgressMap = {
  b: { status: 'in_progress' },
  c: { status: 'done' },
  d: { status: 'human_review' }
}

describe('進み具合の絞り込み', () => {
  it('「だけ表示」は選んだ進み具合のほかをすべて隠す', () => {
    expect(onlyStatus('done')).toHaveLength(FINDING_STATUSES.length - 1)
  })

  it('押すたびに表示と非表示が切り替わる', () => {
    const hidden = toggleStatus([], 'done')
    expect(isStatusShown(hidden, 'done')).toBe(false)
    expect(isStatusShown(toggleStatus(hidden, 'done'), 'done')).toBe(true)
  })

  it('チップを押すと、押したものだけに絞り込む。続けて押すと足す・外す。最後の1つを外すと全部に戻る', () => {
    const only = selectStatus([], 'in_progress')
    expect(FINDING_STATUSES.filter((s) => isStatusShown(only, s))).toEqual(['in_progress'])
    const two = selectStatus(only, 'done')
    expect(FINDING_STATUSES.filter((s) => isStatusShown(two, s))).toEqual(['in_progress', 'done'])
    const back = selectStatus(two, 'done')
    expect(FINDING_STATUSES.filter((s) => isStatusShown(back, s))).toEqual(['in_progress'])
    expect(selectStatus(back, 'in_progress')).toEqual([])
  })

  it('最後の1つまで隠したら、空の一覧にせずすべて表示に戻す', () => {
    expect(toggleStatus(onlyStatus('todo'), 'todo')).toEqual([])
  })

  it('保存した値を読み直す: 知らない値・重複・壊れた形は捨てる', () => {
    expect(sanitizeHiddenStatuses(['done', 'done', 'nope', 3])).toEqual(['done'])
    expect(sanitizeHiddenStatuses('done')).toEqual([])
    expect(sanitizeHiddenStatuses(null)).toEqual([])
    expect(sanitizeHiddenStatuses([...FINDING_STATUSES])).toEqual([])
    // 並びは保存の順ではなくチップの順にそろえる
    expect(sanitizeHiddenStatuses(['done', 'todo'])).toEqual(['todo', 'done'])
  })

  it('チップは未対応・対応中・確認待ち・完了だけ。Agent からの質問（needs_human）のチップは無い', () => {
    expect(FINDING_STATUSES).toEqual(['todo', 'in_progress', 'human_review', 'done'])
    expect(sanitizeHiddenStatuses(['needs_human', 'done'])).toEqual(['done'])
  })

  it('進み具合ごとの件数', () => {
    expect(countByStatus(items, progress)).toEqual({ todo: 1, in_progress: 1, human_review: 1, done: 1 })
    expect(countByStatus(items, undefined).todo).toBe(4)
  })
})

describe('reviewFirst', () => {
  it('確認待ちを上に出し、それぞれの中の並びは保つ', () => {
    const status = { a: 'todo', b: 'human_review', c: 'done', d: 'human_review' } as const
    const rows = ['a', 'b', 'c', 'd']
    expect(reviewFirst(rows, (id) => status[id as keyof typeof status])).toEqual(['b', 'd', 'a', 'c'])
    expect(rows).toEqual(['a', 'b', 'c', 'd'])
  })
})
