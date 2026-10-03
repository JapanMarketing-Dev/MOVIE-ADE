import { describe, expect, it } from 'vitest'
import {
  shouldCaptureStill,
  toJsonLine,
  toLogEvent,
  type RawReviewEvent
} from '../../../src/main/recording/events'

/** 録画開始を epoch 10000 としたときの変換 */
const toClock = (epochMs: number): number => epochMs - 10_000

describe('注入スクリプトの操作ログを pipeline の形へ直す（設計4章）', () => {
  it('クリックを、時刻・座標・指した要素つきで記録する', () => {
    const raw: RawReviewEvent = {
      at: 15_820,
      type: 'click',
      x: 640.4,
      y: 412.6,
      el: { selector: 'a.nav-pricing', text: '料金' }
    }
    expect(toLogEvent(raw, toClock)).toEqual({
      t: 5820,
      type: 'click',
      x: 640,
      y: 413,
      el: { selector: 'a.nav-pricing', text: '料金' }
    })
  })

  it('ペンは、書き始めを時刻に、書き終わりを画像の時刻にする', () => {
    const raw: RawReviewEvent = {
      at: 19_650,
      atStart: 18_200,
      type: 'pen',
      id: 'p3',
      bbox: [590, 380, 180, 64],
      el: { selector: 'button.plan-cta', text: '申し込む' }
    }
    expect(toLogEvent(raw, toClock)).toEqual({
      t: 8200,
      type: 'pen',
      id: 'p3',
      t_end: 9650,
      bbox: [590, 380, 180, 64],
      el: { selector: 'button.plan-cta', text: '申し込む' }
    })
  })

  it('置いたテキストは前後の空白を落として記録する', () => {
    const raw: RawReviewEvent = {
      at: 25_100,
      type: 'text',
      id: 'x1',
      x: 300,
      y: 520,
      body: '  ここは「月額」表記に統一  '
    }
    expect(toLogEvent(raw, toClock)).toEqual({
      t: 15_100,
      type: 'text',
      id: 'x1',
      x: 300,
      y: 520,
      body: 'ここは「月額」表記に統一'
    })
  })

  it('スクロールは位置だけを記録する', () => {
    expect(toLogEvent({ at: 12_000, type: 'scroll', y: 480 }, toClock)).toEqual({
      t: 2000,
      type: 'scroll',
      y: 480
    })
  })

  it('要素が取れなかったときは el を付けない', () => {
    const event = toLogEvent({ at: 11_000, type: 'click', x: 1, y: 2 }, toClock)
    expect(event).not.toHaveProperty('el')
  })

  it('壊れた値は捨てる（レビュー対象は任意のページなので何が来るか分からない）', () => {
    expect(toLogEvent({ at: Number.NaN, type: 'click' }, toClock)).toBeNull()
    expect(toLogEvent({ at: 11_000, type: 'pen', id: 'p1' }, toClock)).toBeNull()
    expect(toLogEvent({ at: 11_000, type: 'text', id: 'x1', body: '   ' }, toClock)).toBeNull()
    expect(toLogEvent({ at: 11_000, type: 'unknown' } as unknown as RawReviewEvent, toClock)).toBeNull()
  })

  it('セレクタが無い要素情報は捨てる', () => {
    const event = toLogEvent(
      { at: 11_000, type: 'click', x: 1, y: 2, el: { text: 'ほげ' } as never },
      toClock
    )
    expect(event).not.toHaveProperty('el')
  })

  it('一時停止をまたいでも、渡された変換に従う', () => {
    // 停止中は fromEpoch が「止めた時点」を返す
    const frozen = (): number => 1000
    expect(toLogEvent({ at: 99_999, type: 'scroll', y: 0 }, frozen)?.t).toBe(1000)
  })
})

describe('書き出しと撮影の判定', () => {
  it('JSON Lines として1行で書ける', () => {
    const line = toJsonLine({ t: 1, type: 'scroll', y: 2 })
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ t: 1, type: 'scroll', y: 2 })
  })

  it('ペン・テキスト・クリックはその場で静止画を撮る', () => {
    expect(shouldCaptureStill({ t: 0, type: 'click', x: 0, y: 0 })).toBe(true)
    expect(shouldCaptureStill({ t: 0, type: 'pen', id: 'p1', t_end: 1, bbox: [0, 0, 1, 1] })).toBe(true)
    expect(shouldCaptureStill({ t: 0, type: 'text', id: 'x1', x: 0, y: 0, body: 'a' })).toBe(true)
  })

  it('スクロールと遷移は定期撮影に任せる', () => {
    expect(shouldCaptureStill({ t: 0, type: 'scroll', y: 0 })).toBe(false)
    expect(shouldCaptureStill({ t: 0, type: 'viewport', width: 390 })).toBe(false)
  })
})
