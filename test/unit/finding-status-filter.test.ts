import { describe, expect, it } from 'vitest'
import { FINDING_STATUSES, countByStatus, filterByStatus, isStatusShown, onlyStatus, sanitizeHiddenStatuses, toggleStatus } from '../../src/shared/findingStatusFilter'
import type { ProgressMap } from '../../src/shared/findingProgress'

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]
const progress: ProgressMap = {
  b: { status: 'in_progress' },
  c: { status: 'done' },
  d: { status: 'human_review' },
  e: { status: 'needs_human' }
}

describe('進み具合の絞り込み', () => {
  it('何も隠していなければすべて出す（progress.json に無い指摘は未対応）', () => {
    expect(filterByStatus(items, progress, []).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(filterByStatus(items, undefined, ['done']).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('隠した進み具合の指摘だけを外す', () => {
    expect(filterByStatus(items, progress, ['done', 'todo']).map((i) => i.id)).toEqual(['b', 'd', 'e'])
  })

  it('「だけ表示」は選んだ進み具合の指摘だけを出す', () => {
    expect(filterByStatus(items, progress, onlyStatus('in_progress')).map((i) => i.id)).toEqual(['b'])
    expect(onlyStatus('done')).toHaveLength(FINDING_STATUSES.length - 1)
  })

  it('押すたびに表示と非表示が切り替わる', () => {
    const hidden = toggleStatus([], 'done')
    expect(isStatusShown(hidden, 'done')).toBe(false)
    expect(isStatusShown(toggleStatus(hidden, 'done'), 'done')).toBe(true)
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

  it('進み具合ごとの件数', () => {
    expect(countByStatus(items, progress)).toEqual({ todo: 1, in_progress: 1, needs_human: 1, human_review: 1, done: 1 })
    expect(countByStatus(items, undefined).todo).toBe(5)
  })
})
