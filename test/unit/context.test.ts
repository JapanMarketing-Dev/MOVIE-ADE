import { describe, expect, it } from 'vitest'
import { buildItemContext } from '../../src/main/pipeline/context'
import type { Event } from '../../src/main/pipeline/types'
import { events } from './fixtures'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

describe('操作ログからの文脈（EXT-4）', () => {
  it('その時刻のURL・タイトル・表示幅を付ける', () => {
    const c = buildItemContext(events, 20_000)
    expect(c.url).toBe('http://localhost:3000/pricing')
    expect(c.title).toBe('料金')
    expect(c.viewport).toBe(1280)
  })

  it('遷移前の時刻なら遷移前のURLを付ける', () => {
    const c = buildItemContext(events, 5_000)
    expect(c.url).toBe('http://localhost:3000/')
  })

  it('ペンが指した要素を優先して付ける', () => {
    const c = buildItemContext(events, 20_000, ['p3'])
    expect(c.element).toEqual({ selector: 'button.plan-cta', text: '申し込む' })
  })

  it('書き込みが無ければ直前のクリック先を要素にする', () => {
    const c = buildItemContext(events, 14_000)
    expect(c.element).toEqual({ selector: 'a.nav-pricing', text: '料金' })
  })

  it('クリックが古すぎれば要素を付けない', () => {
    const c = buildItemContext(events, 40_000)
    expect(c.element).toBeUndefined()
  })

  it('直前の操作を「遷移元 →「テキスト」をクリック → 遷移先」で書く', () => {
    const c = buildItemContext(events, 20_000)
    expect(c.priorOps).toBe('トップ →「料金」をクリック → 料金')
  })

  it('クリックでページが変わっていなければ遷移先を書かない', () => {
    const e: Event[] = [
      { t: 0, type: 'nav', url: 'http://x/', title: 'トップ' },
      { t: 5_000, type: 'click', x: 1, y: 2, el: { selector: 'button.more', text: 'もっと見る' } },
    ]
    expect(buildItemContext(e, 6_000).priorOps).toBe('トップ →「もっと見る」をクリック')
  })

  it('クリックが無ければ遷移だけを書く', () => {
    const e: Event[] = [{ t: 1_000, type: 'nav', url: 'http://x/', title: 'トップ' }]
    expect(buildItemContext(e, 2_000).priorOps).toBe('トップ へ遷移')
    expect(buildItemContext(e, 120_000).priorOps).toBe('トップ を表示中')
  })

  it('要素のテキストが無ければ座標で書く', () => {
    const e: Event[] = [
      { t: 0, type: 'nav', url: 'http://x/', title: 'トップ' },
      { t: 1_000, type: 'click', x: 10, y: 20, el: { selector: 'div.canvas' } },
    ]
    expect(buildItemContext(e, 2_000).priorOps).toBe('トップ → (10, 20) をクリック')
  })

  it('英語の画面では英語で書く', () => {
    setLocale('en')
    const e: Event[] = [
      { t: 0, type: 'nav', url: 'http://x/', title: 'Top' },
      { t: 1_000, type: 'click', x: 1, y: 1, el: { selector: 'a', text: 'Pricing' } },
      { t: 1_500, type: 'nav', url: 'http://x/p', title: 'Pricing' },
    ]
    expect(buildItemContext(e, 3_000).priorOps).toBe('Top → clicked "Pricing" → Pricing')
    expect(buildItemContext(e.slice(0, 1), 2_000).priorOps).toBe('Navigated to Top')
    setLocale('ja')
  })

  it('操作ログが空でも落ちない', () => {
    expect(buildItemContext([], 1_000)).toEqual({})
  })

  it('スマホ幅に切り替えた後は表示幅がそちらになる', () => {
    const e: Event[] = [
      ...events,
      { t: 50_000, type: 'viewport', width: 390 },
    ]
    expect(buildItemContext(e, 55_000).viewport).toBe(390)
  })
})
