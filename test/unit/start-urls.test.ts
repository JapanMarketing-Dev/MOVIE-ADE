import { describe, expect, it } from 'vitest'
import { DEV_URL_FALLBACKS, START_RECENT_LIMIT, startUrlChoices } from '@shared/startUrls'
import { pushRecentUrl } from '@shared/reviewTarget'

describe('startUrlChoices（内蔵ブラウザの開始画面の候補）', () => {
  it('登録した URL をツールバーと同じ順・名前で出し、名前が無ければ URL から推し量る', () => {
    const c = startUrlChoices({
      targets: [
        { label: 'dev', url: 'https://dev.acme-shop.test/' },
        { label: '  ', url: 'http://localhost:4000' },
        { label: 'prd', url: 'https://acme-shop.test' },
        { label: 'Simulator' },
        { label: 'file', url: 'file:///tmp/x.html' }
      ],
      history: []
    })
    expect(c.presets).toEqual([
      { label: 'dev', url: 'https://dev.acme-shop.test/' },
      { label: 'local', url: 'http://localhost:4000' },
      { label: 'prd', url: 'https://acme-shop.test' }
    ])
    // 登録があれば localhost の補助は出さない
    expect(c.fallback).toEqual([])
  })

  it('最近開いた URL は新しい順で、登録した URL と同じページ・重複・http(s) 以外を除き、上限で切る', () => {
    const history = [
      'https://dev.acme-shop.test/',
      'https://dev.acme-shop.test/cart',
      'ade-preview://local/README.md',
      'https://dev.acme-shop.test/cart#top',
      'about:blank',
      ...Array.from({ length: 10 }, (_, i) => `https://acme-shop.test/p/${i}`)
    ]
    const c = startUrlChoices({ targets: [{ label: 'dev', url: 'https://dev.acme-shop.test' }], history })
    expect(c.recent[0]).toBe('https://dev.acme-shop.test/cart')
    expect(c.recent).not.toContain('https://dev.acme-shop.test/')
    expect(c.recent).not.toContain('https://dev.acme-shop.test/cart#top')
    expect(c.recent.some((u) => !u.startsWith('http'))).toBe(false)
    expect(c.recent).toHaveLength(START_RECENT_LIMIT)
    expect(startUrlChoices({ targets: [], history, limit: 2 }).recent).toHaveLength(2)
  })

  it('登録が無ければ localhost の補助を出す（最近開いたものと同じページは除く）', () => {
    expect(startUrlChoices({ targets: [], history: [] })).toEqual({ presets: [], recent: [], fallback: [...DEV_URL_FALLBACKS] })
    const c = startUrlChoices({ targets: [], history: ['http://localhost:5173/'] })
    expect(c.recent).toEqual(['http://localhost:5173/'])
    expect(c.fallback).toEqual(['http://localhost:3000', 'http://localhost:8080'])
  })

  it('壊れた履歴（保存した JSON の文字列・配列以外・文字列以外の要素）でも落ちない', () => {
    expect(startUrlChoices({ targets: [], history: '["https://a.test/x", 1, null]' }).recent).toEqual(['https://a.test/x'])
    expect(startUrlChoices({ targets: [], history: '{broken' }).recent).toEqual([])
    expect(startUrlChoices({ targets: [], history: { a: 1 } }).recent).toEqual([])
  })
})

describe('pushRecentUrl（最近開いた URL の更新）', () => {
  it('先頭に足し、同じページは1つにまとめ、上限で切る', () => {
    let list: string[] = []
    for (const url of ['https://a.test/1', 'https://a.test/2', 'https://a.test/1?', 'https://a.test/3']) list = pushRecentUrl(list, url, 3)
    expect(list).toEqual(['https://a.test/3', 'https://a.test/1?', 'https://a.test/2'])
    expect(pushRecentUrl(list, 'https://a.test/4', 3)).toEqual(['https://a.test/4', 'https://a.test/3', 'https://a.test/1?'])
  })
  it('空・about:blank は積まない', () => {
    expect(pushRecentUrl(['https://a.test/'], '')).toEqual(['https://a.test/'])
    expect(pushRecentUrl(['https://a.test/'], 'about:blank')).toEqual(['https://a.test/'])
  })
})
