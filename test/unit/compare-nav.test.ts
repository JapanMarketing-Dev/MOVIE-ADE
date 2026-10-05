import { describe, expect, it } from 'vitest'
import { afterVerdict, compareNav } from '../../src/shared/compareNav'

// a〜f の表示順。b・d・e が確認待ち（AFTER あり）、c は完了で AFTER あり、a・f は AFTER なし
const order = ['a', 'b', 'c', 'd', 'e', 'f']
const awaiting = new Set(['b', 'd', 'e'])
const after = new Set(['b', 'c', 'd', 'e'])
const isAwaiting = (id: string) => awaiting.has(id)
const hasAfter = (id: string) => after.has(id)

describe('比べる画面の前後の移動', () => {
  it('確認待ちから開いたら、確認待ちの中を表示順に移動し、位置は確認待ちの中の位置', () => {
    expect(compareNav(order, 'd', isAwaiting, hasAfter)).toEqual({ list: ['b', 'd', 'e'], index: 1, prev: 'b', next: 'e', awaiting: true })
  })

  it('端では止まる（回り込まない）', () => {
    expect(compareNav(order, 'b', isAwaiting, hasAfter)).toMatchObject({ index: 0, prev: null, next: 'd' })
    expect(compareNav(order, 'e', isAwaiting, hasAfter)).toMatchObject({ index: 2, prev: 'd', next: null })
  })

  it('確認待ちでない指摘から開いたら、AFTER のある指摘の中を移動する', () => {
    expect(compareNav(order, 'c', isAwaiting, hasAfter)).toEqual({ list: ['b', 'c', 'd', 'e'], index: 1, prev: 'b', next: 'd', awaiting: false })
  })

  it('今の指摘は AFTER が読めなくても並びに残す', () => {
    expect(compareNav(order, 'a', isAwaiting, hasAfter)).toMatchObject({ list: ['a', 'b', 'c', 'd', 'e'], index: 0, prev: null, next: 'b' })
  })

  it('今の指摘が表示順に無ければ位置は -1 で、前後は無い', () => {
    expect(compareNav(order, 'zz', isAwaiting, hasAfter)).toMatchObject({ index: -1, prev: null, next: null })
  })
})

describe('判定したあとに出す指摘', () => {
  it('後ろの確認待ちを先に出す', () => {
    expect(afterVerdict(order, 'b', isAwaiting, 'ok')).toEqual({ kind: 'go', id: 'd' })
    expect(afterVerdict(order, 'd', isAwaiting, 'ng')).toEqual({ kind: 'go', id: 'e' })
  })

  it('後ろに無ければ先頭へ戻って探す', () => {
    expect(afterVerdict(order, 'e', isAwaiting, 'ok')).toEqual({ kind: 'go', id: 'b' })
  })

  it('確認待ちでない指摘から判定しても、その後ろの確認待ちへ進む', () => {
    expect(afterVerdict(order, 'c', isAwaiting, 'ok')).toEqual({ kind: 'go', id: 'd' })
  })

  it('ほかに確認待ちが無ければ、OK・NG は終わり、コメントはその指摘に留まる', () => {
    const only = (id: string) => id === 'b'
    expect(afterVerdict(order, 'b', only, 'ok')).toEqual({ kind: 'done' })
    expect(afterVerdict(order, 'b', only, 'ng')).toEqual({ kind: 'done' })
    expect(afterVerdict(order, 'b', only, 'comment')).toEqual({ kind: 'stay' })
  })

  it('今の指摘が表示順に無くても、先頭から確認待ちを探す', () => {
    expect(afterVerdict(order, 'zz', isAwaiting, 'ok')).toEqual({ kind: 'go', id: 'b' })
  })
})
