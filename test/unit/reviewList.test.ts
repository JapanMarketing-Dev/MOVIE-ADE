import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REVIEW_FILTER,
  filterReviews,
  formatReviewDuration,
  isEmptyDraft,
  isFilterActive,
  reviewHeading,
  reviewHost,
  reviewHosts,
  sanitizeReviewFilter,
  sortReviews,
  type ReviewListEntry
} from '../../src/shared/reviewList'

const entry = (patch: Partial<ReviewListEntry> & { id: string }): ReviewListEntry => ({
  status: 'draft', findings: 3, target: 'https://example.com/pricing', ...patch
})

const list: ReviewListEntry[] = [
  entry({ id: '20261003-100000', startedAt: '2026-10-03T01:00:00.000Z', title: '料金プラン', searchText: '料金プラン\n余白が広すぎる' }),
  entry({ id: '20261003-090000', startedAt: '2026-10-03T00:00:00.000Z', target: 'http://127.0.0.1:5173/', findings: 0 }),
  entry({ id: '20261002-180000', startedAt: '2026-10-02T09:00:00.000Z', status: 'sent', target: 'https://example.com/contact', title: 'お問い合わせ' }),
  entry({ id: '20261002-170000', startedAt: '2026-10-02T08:00:00.000Z', status: 'incomplete', findings: 0, target: 'http://127.0.0.1:5173/admin' }),
  entry({ id: '20261002-160000', startedAt: '2026-10-02T07:00:00.000Z', status: 'broken', findings: 0, target: '（対象なし）' }),
  entry({ id: '20261001-120000', startedAt: '2026-10-01T03:00:00.000Z', archived: true, name: '古い確認' })
]
const ids = (entries: ReviewListEntry[]) => entries.map((e) => e.id)

describe('レビュー一覧のフィルタ', () => {
  it('既定では、指摘0件の下書きとアーカイブを隠す（未完了・開けないものは残す）', () => {
    expect(ids(filterReviews(list, DEFAULT_REVIEW_FILTER))).toEqual(['20261003-100000', '20261002-180000', '20261002-170000', '20261002-160000'])
  })

  it('「指摘0件を隠す」を外すと、空の下書きも出る', () => {
    expect(ids(filterReviews(list, { ...DEFAULT_REVIEW_FILTER, hideEmpty: false }))).toContain('20261003-090000')
  })

  it('アーカイブを表示できる', () => {
    expect(ids(filterReviews(list, { ...DEFAULT_REVIEW_FILTER, showArchived: true }))).toContain('20261001-120000')
  })

  it('状態で絞る。開けないものは「未完了」に入る', () => {
    expect(ids(filterReviews(list, { ...DEFAULT_REVIEW_FILTER, statuses: ['sent'] }))).toEqual(['20261002-180000'])
    expect(ids(filterReviews(list, { ...DEFAULT_REVIEW_FILTER, statuses: ['incomplete'] }))).toEqual(['20261002-170000', '20261002-160000'])
    expect(ids(filterReviews(list, { ...DEFAULT_REVIEW_FILTER, statuses: ['draft', 'sent'] }))).toEqual(['20261003-100000', '20261002-180000'])
  })

  it('対象のホストで絞る', () => {
    expect(ids(filterReviews(list, { ...DEFAULT_REVIEW_FILTER, hideEmpty: false, host: '127.0.0.1:5173' }))).toEqual(['20261003-090000', '20261002-170000'])
  })

  it('検索はタイトル・URL・指摘の本文・名前を見る。語はすべて含むものだけ、大文字小文字は問わない', () => {
    const search = (query: string) => ids(filterReviews(list, { ...DEFAULT_REVIEW_FILTER, showArchived: true, query }))
    expect(search('余白')).toEqual(['20261003-100000'])
    expect(search('CONTACT')).toEqual(['20261002-180000'])
    expect(search('料金 余白')).toEqual(['20261003-100000'])
    expect(search('料金 問い合わせ')).toEqual([])
    expect(search('古い')).toEqual(['20261001-120000'])
    expect(search('  ')).toHaveLength(5)
  })
})

describe('並び替え・見出し・ホスト', () => {
  it('新しい順。収録時刻が無いものは元の並びのまま後ろ', () => {
    const shuffled = [list[2]!, entry({ id: 'demo-a' }), list[0]!, entry({ id: 'demo-b' }), list[1]!]
    expect(ids(sortReviews(shuffled))).toEqual(['20261003-100000', '20261003-090000', '20261002-180000', 'demo-a', 'demo-b'])
  })

  it('見出しは 名前 → タイトル → URLのパス → ホスト → 対象の文', () => {
    expect(reviewHeading(entry({ id: 'a', name: '料金の確認', title: '料金' }))).toBe('料金の確認')
    expect(reviewHeading(entry({ id: 'a', title: '料金' }))).toBe('料金')
    expect(reviewHeading(entry({ id: 'a', target: 'http://127.0.0.1:5173/admin/users' }))).toBe('/admin/users')
    expect(reviewHeading(entry({ id: 'a', target: 'http://127.0.0.1:5173/' }))).toBe('127.0.0.1:5173')
    expect(reviewHeading(entry({ id: 'a', target: 'ade-preview://project/docs/%E8%A8%AD%E8%A8%88.md' }))).toBe('/docs/設計.md')
    expect(reviewHeading(entry({ id: 'a', target: '（対象なし）' }))).toBe('（対象なし）')
  })

  it('ホストは http(s) ならポート込み、それ以外のURLはスキーム、URLでなければ空', () => {
    expect(reviewHost('http://127.0.0.1:5173/a')).toBe('127.0.0.1:5173')
    expect(reviewHost('https://example.com/')).toBe('example.com')
    expect(reviewHost('ade-preview://project/a.md')).toBe('ade-preview:')
    expect(reviewHost('（対象なし）')).toBe('')
  })

  it('ホストの候補は件数の多い順', () => {
    expect(reviewHosts(list)).toEqual([
      { host: 'example.com', count: 3 },
      { host: '127.0.0.1:5173', count: 2 }
    ])
  })

  it('空の下書き', () => {
    expect(isEmptyDraft(list[1]!)).toBe(true)
    expect(isEmptyDraft(list[0]!)).toBe(false)
    expect(isEmptyDraft(list[3]!)).toBe(false) // 未完了は復元できるので含めない
  })

  it('録画の長さ', () => {
    expect(formatReviewDuration(0)).toBe('')
    expect(formatReviewDuration(undefined)).toBe('')
    expect(formatReviewDuration(4_200)).toBe('0:04')
    expect(formatReviewDuration(65_000)).toBe('1:05')
    expect(formatReviewDuration(3_723_000)).toBe('1:02:03')
  })
})

describe('保存したフィルタ', () => {
  it('壊れた値は既定へ。知らない状態は捨てる', () => {
    expect(sanitizeReviewFilter(null)).toEqual(DEFAULT_REVIEW_FILTER)
    expect(sanitizeReviewFilter({ statuses: ['sent', 'bogus'], hideEmpty: false, host: '', query: 1 }))
      .toEqual({ query: '', statuses: ['sent'], hideEmpty: false, showArchived: false, host: null })
  })

  it('既定から変えているか', () => {
    expect(isFilterActive(DEFAULT_REVIEW_FILTER)).toBe(false)
    expect(isFilterActive({ ...DEFAULT_REVIEW_FILTER, query: 'x' })).toBe(false)
    expect(isFilterActive({ ...DEFAULT_REVIEW_FILTER, host: 'example.com' })).toBe(true)
    expect(isFilterActive({ ...DEFAULT_REVIEW_FILTER, hideEmpty: false })).toBe(true)
  })
})
