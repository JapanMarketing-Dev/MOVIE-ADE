import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHARE_INPUTS, SHARE_JS } from '../../workers/feedback-share/src/generated'
import { ShapeDrawing } from '../../src/shared/annotationPointer'

/**
 * 共有リンクの相手の画面のまとめ（workers/feedback-share/src/generated.ts）が、元のファイルと合っているか。
 * アプリの FeedbackToolbar・書き込みの部品・tokens.css などを変えたら node scripts/build-share-page.mjs で作り直す。
 */

const ROOT = resolve(__dirname, '../..')

describe('共有リンクの相手の画面のまとめ', () => {
  it('まとめた元のファイルが変わっていない（変えたら node scripts/build-share-page.mjs）', () => {
    const stale = Object.entries(SHARE_INPUTS).filter(([file, hash]) => {
      const path = resolve(ROOT, file)
      return !existsSync(path) || createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16) !== hash
    }).map(([file]) => file)
    expect(stale).toEqual([])
  })

  it('アプリと同じ録画の帯と書き込みの部品を使う（別に作らない）', () => {
    const files = Object.keys(SHARE_INPUTS)
    expect(files).toEqual(expect.arrayContaining([
      'src/renderer/components/FeedbackToolbar.tsx',
      'src/shared/annotationPointer.ts',
      'src/shared/annotationPaint.ts',
      'src/shared/noteEditorDom.ts',
      'src/renderer/styles/feedback.css'
    ]))
    // アプリの注入スクリプトも同じ部品を使う
    const preload = readFileSync(resolve(ROOT, 'src/preload/review.ts'), 'utf8')
    for (const name of ['annotationPointer', 'annotationPaint', 'noteEditorDom']) expect(preload).toContain(`from '../shared/${name}'`)
    expect(SHARE_JS.length).toBeLessThan(1_500_000)
  })
})

describe('書き込みの手順（src/shared/annotationPointer.ts）', () => {
  it('描く・つかんで動かす・元に戻す／やり直すを、記録へ送るものと一緒に返す', () => {
    let t = 1000
    let n = 0
    const applied: Array<{ records: unknown[]; atStart: number }> = []
    const drawing = new ShapeDrawing({ newId: () => `p${++n}`, now: () => t, onRedraw: () => undefined, onApply: (change, atStart) => applied.push({ records: change.records, atStart }) })
    drawing.down(10, 10, 'rect', 'rose')
    t = 1200
    drawing.move(60, 40)
    drawing.finish()
    expect(drawing.shapes.shapes).toHaveLength(1)
    expect(applied[0]).toMatchObject({ atStart: 1000, records: [{ type: 'draw', shape: { kind: 'rect', rect: [10, 10, 50, 30], id: 'p1' } }] })
    // 枠の線をつかんで動かす（新しい ID で、前の ID を replaces に）
    drawing.down(10, 20, 'pen', 'rose')
    drawing.move(30, 40)
    drawing.finish()
    expect(applied[1]!.records).toEqual([{ type: 'draw', shape: expect.objectContaining({ rect: [30, 30, 50, 30], id: 'p2' }), replaces: 'p1' }])
    expect(drawing.undo()).toBe(true)
    expect(drawing.redo()).toBe(true)
    // クリックだけの枠は描かない
    drawing.down(300, 300, 'rect', 'blue')
    drawing.finish()
    expect(drawing.shapes.shapes).toHaveLength(1)
    // 消去は元に戻せる
    drawing.clear(true)
    expect(drawing.visible()).toEqual([])
    expect(drawing.undo()).toBe(true)
    expect(drawing.visible()).toHaveLength(1)
  })
})
