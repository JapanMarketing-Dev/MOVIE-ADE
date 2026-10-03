import { describe, expect, it } from 'vitest'
import { ANNOTATION_COLOR_IDS, normalizeAnnotationColor, rectFromDrag } from '../../src/shared/annotation'
import { toLogEvent } from '../../src/main/recording/events'

describe('書き込みの色', () => {
  it('知らない値は既定のローズ', () => {
    expect(normalizeAnnotationColor('blue')).toBe('blue')
    expect(normalizeAnnotationColor('purple')).toBe('rose')
    expect(normalizeAnnotationColor(undefined)).toBe('rose')
    expect(normalizeAnnotationColor('toString')).toBe('rose')
  })

  it('落ち着いた色（青・黒）を候補に含む', () => {
    expect(ANNOTATION_COLOR_IDS).toEqual(expect.arrayContaining(['blue', 'black']))
  })
})

describe('四角の枠', () => {
  it('どの向きにドラッグしても左上と大きさになる', () => {
    expect(rectFromDrag(100, 80, 20, 10)).toEqual([20, 10, 80, 70])
    expect(rectFromDrag(20, 10, 100, 80)).toEqual([20, 10, 80, 70])
  })

  it('クリックの手ぶれは枠にしない', () => {
    expect(rectFromDrag(10, 10, 12, 13)).toBeNull()
  })

  it('操作ログに shape: rect を残す。手書きの線には付けない', () => {
    const base = { at: 2000, atStart: 1500, type: 'pen' as const, id: 'p1-x', bbox: [1, 2, 30, 40] as [number, number, number, number] }
    expect(toLogEvent({ ...base, shape: 'rect' }, (ms) => ms - 1000)).toMatchObject({ type: 'pen', shape: 'rect', t: 500, t_end: 1000 })
    expect(toLogEvent(base, (ms) => ms - 1000)).not.toHaveProperty('shape')
    expect(toLogEvent({ ...base, shape: 'circle' }, (ms) => ms - 1000)).not.toHaveProperty('shape')
  })
})
