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

const acc = (id: string, email: string | null, createdAt: number, signedIn = true, workspaceLabel: string | null = null) => ({ id, email, workspaceLabel, createdAt, signedIn })
const system = (email: string | null) => ({ signedIn: !!email, email, workspaceLabel: null })

describe('同じログインを2つ登録しない', () => {
  it('同じメールを2回追加したら、後から追加したものを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'X@example.com', 2), acc('c', 'y@example.com', 3)], null, system(null))).toEqual(['b'])
  })

  it('選択中のものは残し、ほかを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system(null))).toEqual(['a'])
  })

  it('システムの既定と同じログインを追加したら外す。選択中なら残す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2), acc('g', 'g@example.com', 3)], null, system('x@example.com'))).toEqual(['a', 'b'])
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system('x@example.com'))).toEqual(['a'])
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
