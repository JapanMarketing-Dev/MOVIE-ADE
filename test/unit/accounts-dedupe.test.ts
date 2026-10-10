/**
 * 足元のアカウントの内訳で、同じログインの行を1つにする（同じアカウントを2回追加した・システムの既定も同じログイン）
 */
import { describe, expect, it } from 'vitest'
import { dedupeAccountRows } from '../../src/shared/accounts'

const row = (accountId: string | null, email: string | null, workspaceLabel: string | null = null) => ({ accountId, email, workspaceLabel })

describe('同じログインの行をまとめる', () => {
  it('システムの既定と同じメールを2回追加しても、選択中の1行だけ残す。ほかのアカウントはそのまま', () => {
    const rows = [row(null, 'a@example.com'), row('x', 'a@example.com'), row('y', 'A@Example.com '), row('z', 'b@example.com')]
    expect(dedupeAccountRows(rows, 'y').map((r) => r.accountId)).toEqual(['y', 'z'])
  })

  it('選択中が無い（システムの既定を使っている）ならシステムの既定を残す', () => {
    const rows = [row(null, 'a@example.com'), row('x', 'a@example.com'), row('z', 'b@example.com')]
    expect(dedupeAccountRows(rows, null).map((r) => r.accountId)).toEqual([null, 'z'])
  })

  it('同じメールでも組織が違えば別の行。メールが分からない行はまとめない', () => {
    const rows = [row(null, null), row('x', 'a@example.com', 'Acme'), row('y', 'a@example.com', 'Personal'), row('w', null)]
    expect(dedupeAccountRows(rows, null).map((r) => r.accountId)).toEqual([null, 'x', 'y', 'w'])
  })
})

import { duplicateAccountIds } from '../../src/shared/accounts'

const acc = (id: string, email: string | null, createdAt: number, signedIn = true, workspaceLabel: string | null = null, fresh = true) => ({ id, email, workspaceLabel, createdAt, signedIn, fresh })
const old = (id: string, email: string | null, createdAt: number) => acc(id, email, createdAt, true, null, false)
const system = (email: string | null) => ({ signedIn: !!email, email, workspaceLabel: null })

describe('同じログインを2つ登録しない', () => {
  it('同じメールを2回追加したら、後から追加したものを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'X@example.com', 2), acc('c', 'y@example.com', 3)], null, system(null))).toEqual(['b'])
  })

  it('追加したばかりのものどうしは、選択中のものを残し、ほかを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system(null))).toEqual(['a'])
  })

  it('システムの既定と同じログインを追加したら、追加したほうを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2), acc('g', 'g@example.com', 3)], null, system('x@example.com'))).toEqual(['a', 'b'])
    expect(duplicateAccountIds([acc('b', 'x@example.com', 2)], 'b', system('x@example.com'))).toEqual(['b'])
  })

  it('ログイン待ち・メールが分からない・組織が違うものは外さない', () => {
    expect(duplicateAccountIds([
      acc('a', 'x@example.com', 1, true, 'Acme'),
      acc('b', 'x@example.com', 2, true, 'Personal'),
      acc('c', 'x@example.com', 3, false, 'Acme'),
      acc('d', null, 4)
    ], null, system(null))).toEqual([])
  })
})

describe('前から使っているアカウントは決して外さない（2026-10-10 の消失）', () => {
  it('同じログインを追加して選択中にしても、前からあるほうは外さず、追加したほうを外す', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system(null))).toEqual(['b'])
  })

  it('システムの既定と同じログインでも、選択中でなくても、前からあるものは外さない', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], null, system('x@example.com'))).toEqual(['b'])
    expect(duplicateAccountIds([old('a', 'x@example.com', 1)], null, system('x@example.com'))).toEqual([])
  })

  it('前からあるものどうしが同じログインになっても（タブの中で /login し直した）どちらも外さない', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), old('b', 'x@example.com', 2)], 'b', system('x@example.com'))).toEqual([])
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), old('b', 'X@Example.com', 2)], null, system(null))).toEqual([])
  })

  it('別のログインを追加しても何も外さない', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'y@example.com', 2)], 'b', system('z@example.com'))).toEqual([])
  })
})
