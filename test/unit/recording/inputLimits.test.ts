import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import { DEFAULT_REVIEW_EVENT_LIMITS, ReviewEventBudget } from '../../../src/main/recording/eventBudget'
import { MAX_ANNOTATION_ID_LENGTH, MAX_ELEMENT_TEXT_LENGTH, MAX_ERASE_IDS, MAX_SELECTOR_LENGTH, toLogEvent, type RawReviewEvent } from '../../../src/main/recording/events'
import { StillCapturer, type StillSource } from '../../../src/main/recording/stills'
import type { RecordingClock } from '../../../src/main/recording/clock'
import type { RecordingOptions } from '../../../src/main/recording/types'
import { acceptClick, isSameOriginNavigation, type LastClick } from '../../../src/shared/reviewInput'

/** 進め方を決められる時計 */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000
  return { now: () => at, advance: (ms) => { at += ms } }
}

describe('ページの合成の入力（CWE-400）', () => {
  it('security-2 [10] 何万回の合成クリック（isTrusted でない）は1件も記録しない', () => {
    let last: LastClick | null = null
    let recorded = 0
    for (let i = 0; i < 50_000; i++) {
      const accepted = acceptClick({ isTrusted: false, clientX: i % 800, clientY: 100 }, last, 1_000 + i)
      if (accepted) { recorded++; last = accepted }
    }
    expect(recorded).toBe(0)
  })

  it('人のクリックは記録し、ダブルクリック・同じ場所の連打は1件にまとめる', () => {
    const first = acceptClick({ isTrusted: true, clientX: 100, clientY: 100 }, null, 1_000)
    expect(first).toEqual({ at: 1_000, x: 100, y: 100 })
    expect(acceptClick({ isTrusted: true, clientX: 101, clientY: 100 }, first, 1_120)).toBeNull()
    // 離れた場所・間を置いたクリックは別の1件
    expect(acceptClick({ isTrusted: true, clientX: 300, clientY: 100 }, first, 1_120)).not.toBeNull()
    expect(acceptClick({ isTrusted: true, clientX: 100, clientY: 100 }, first, 1_400)).not.toBeNull()
  })

  it('遷移の直前の知らせは、同じオリジンの URL だけを使う（ページが勝手に送った値を捨てる）', () => {
    expect(isSameOriginNavigation('http://localhost:3000/pricing', 'http://localhost:3000/')).toBe(true)
    expect(isSameOriginNavigation('https://evil.example/', 'http://localhost:3000/')).toBe(false)
    expect(isSameOriginNavigation('not a url', 'http://localhost:3000/')).toBe(false)
  })
})

describe('main 側の頻度と総量の上限', () => {
  it('security-2 [10] 本物の操作を真似ても、1秒に何万回のクリックは上限の数しか通さない', () => {
    const clock = fakeClock()
    const budget = new ReviewEventBudget(DEFAULT_REVIEW_EVENT_LIMITS, clock.now)
    let ok = 0
    for (let i = 0; i < 50_000; i++) {
      if (budget.admit('click') === 'ok') ok++
      if (i % 50 === 0) clock.advance(1) // 1秒で 50,000 回
    }
    const { capacity, perSecond } = DEFAULT_REVIEW_EVENT_LIMITS.rates.click
    expect(ok).toBeLessThanOrEqual(capacity + perSecond + 1)
  })

  it('security-2 [10] 同じドキュメント内の遷移を高い頻度で繰り返しても、nav の記録は上限の数に収まる', () => {
    const clock = fakeClock()
    const budget = new ReviewEventBudget(DEFAULT_REVIEW_EVENT_LIMITS, clock.now)
    let ok = 0
    for (let i = 0; i < 10_000; i++) {
      if (budget.admit('nav') === 'ok') ok++
      if (i % 1_000 === 0) clock.advance(100) // 1秒で 10,000 回の pushState
    }
    const { capacity, perSecond } = DEFAULT_REVIEW_EVENT_LIMITS.rates.nav
    expect(ok).toBeLessThanOrEqual(capacity + perSecond + 1)
  })

  it('人の速さのクリック（毎秒3回を1分）は全部通す', () => {
    const clock = fakeClock()
    const budget = new ReviewEventBudget(DEFAULT_REVIEW_EVENT_LIMITS, clock.now)
    let ok = 0
    for (let i = 0; i < 180; i++) {
      if (budget.admit('click') === 'ok') ok++
      clock.advance(333)
    }
    expect(ok).toBe(180)
  })

  it('1回の録画で記録する件数に上限があり、超えたら total で捨てる', () => {
    const clock = fakeClock()
    const budget = new ReviewEventBudget({ ...DEFAULT_REVIEW_EVENT_LIMITS, maxEvents: 100 }, clock.now)
    const results: string[] = []
    for (let i = 0; i < 300; i++) {
      results.push(budget.admit(i % 2 ? 'click' : 'pen'))
      clock.advance(1_000)
    }
    expect(results.filter((r) => r === 'ok')).toHaveLength(100)
    expect(results.at(-1)).toBe('total')
    expect(budget.recordedCount).toBe(100)
  })

  it('記録しない入力（カーソル・キー）は件数に数えない', () => {
    const clock = fakeClock()
    const budget = new ReviewEventBudget({ ...DEFAULT_REVIEW_EVENT_LIMITS, maxEvents: 1 }, clock.now)
    for (let i = 0; i < 10; i++) { budget.admit('pointer'); clock.advance(1_000) }
    expect(budget.admit('click')).toBe('ok')
    expect(budget.admit('shortcut')).toBe('ok')
  })
})

describe('ページから届く値の大きさ', () => {
  const toClock = (epochMs: number): number => epochMs - 10_000

  it('長いセレクタ・表示テキストは上限で切る', () => {
    const event = toLogEvent({ at: 11_000, type: 'click', x: 1, y: 2, el: { selector: 'a'.repeat(100_000), text: 'あ'.repeat(100_000) } }, toClock)
    expect(event?.type === 'click' && event.el?.selector.length).toBe(MAX_SELECTOR_LENGTH)
    expect(event?.type === 'click' && event.el?.text?.length).toBe(MAX_ELEMENT_TEXT_LENGTH)
  })

  it('長すぎる ID の書き込みは捨て、取り消しの ID の数も上限で切る', () => {
    expect(toLogEvent({ at: 11_000, type: 'pen', id: 'p'.repeat(MAX_ANNOTATION_ID_LENGTH + 1), bbox: [0, 0, 1, 1] }, toClock)).toBeNull()
    const ids = Array.from({ length: 10_000 }, (_, i) => `p${i}`)
    const erase = toLogEvent({ at: 11_000, type: 'erase', ids } as RawReviewEvent, toClock)
    expect(erase?.type === 'erase' && erase.ids.length).toBe(MAX_ERASE_IDS)
  })

  it('極端な座標・大きさは丸めて、数でない書き始めは使わない', () => {
    const pen = toLogEvent({ at: 11_000, atStart: Number.NaN, type: 'pen', id: 'p1', bbox: [1e12, -1e12, 5, Number.POSITIVE_INFINITY] }, toClock)
    expect(pen).toMatchObject({ t: 1_000, bbox: [100_000, -100_000, 5, 0] })
  })
})

describe('静止画の強制撮影のあふれ', () => {
  /** 撮るたびに数を数える、小さな画像を返す元 */
  function fakeSource(): StillSource & { calls: number } {
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 64, height: 32 }),
      resize: () => image,
      toBitmap: () => Buffer.alloc(32 * 16 * 4, 1),
      toJPEG: () => Buffer.alloc(100),
      toPNG: () => Buffer.alloc(100)
    } as unknown as NativeImage
    const source = { calls: 0, gone: false, capture: async () => { source.calls++; return image } }
    return source
  }

  async function capturer(limits: Partial<ConstructorParameters<typeof StillCapturer>[4]> = {}, now = Date.now) {
    const framesDir = await mkdtemp(join(tmpdir(), 'ade-stills-'))
    const options = { stillIntervalMs: 500, stillFormat: 'jpeg', stillQuality: 80, stillMaxWidth: 1600, paths: { framesDir } } as unknown as RecordingOptions
    const clock = { now: () => 0 } as unknown as RecordingClock
    const warnings: string[] = []
    const source = fakeSource()
    const stills = new StillCapturer(source, clock, options, { onFrame: () => undefined, onWarning: (m) => warnings.push(m) },
      { maxCount: 20_000, maxBytes: 1024 ** 3, maxPendingForced: 4, minClickIntervalMs: 250, ...limits }, now)
    return { stills, source, warnings }
  }

  it('security-2 [10] クリックの連打で強制撮影を積み上げない（間隔と待ち行列の上限）', async () => {
    const { stills, source } = await capturer()
    await Promise.all(Array.from({ length: 10_000 }, () => stills.captureNow('click')))
    expect(source.calls).toBeLessThanOrEqual(1)
  })

  it('ペンの確定は間隔を問わず撮るが、待ち行列の上限は超えない', async () => {
    const { stills, source } = await capturer()
    await Promise.all(Array.from({ length: 1_000 }, (_, i) => stills.captureNow('pen', undefined, `p${i}`)))
    expect(source.calls).toBeGreaterThan(0)
    expect(source.calls).toBeLessThanOrEqual(4)
  })

  it('security-2 [10] 撮影が返ってこなくても、停止は上限の時間で終わり、停止後の強制撮影は受け付けない', async () => {
    const { stills, source } = await capturer()
    // capturePage が返ってこない元
    source.capture = () => new Promise(() => undefined)
    void stills.captureNow('nav')
    const started = Date.now()
    await stills.settle(100)
    expect(Date.now() - started).toBeLessThan(1_000)
    const stopping = stills.stop()
    expect(await stills.captureNow('click')).toBeNull()
    void stopping
  })

  it('静止画の数の上限に達したら保存をやめ、1度だけ知らせる', async () => {
    const { stills, warnings } = await capturer({ maxCount: 2 })
    for (let i = 0; i < 5; i++) await stills.captureNow('pen', undefined, `p${i}`)
    expect(stills.captured).toHaveLength(2)
    expect(warnings).toHaveLength(1)
  })
})
