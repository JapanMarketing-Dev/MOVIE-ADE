import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import { applyEdits } from '../../src/main/sessions/edits'
import { frameFilePath, sessionPaths, takePaths } from '../../src/main/sessions/paths'
import type { SessionRecord } from '../../src/main/sessions/store'
import { TAKE_GAP_MS, appendTake, framesOfTake, listTakes, nextTakeNumber, type TakeMaterial } from '../../src/main/sessions/takes'
import { isUnsentTake, takeAt, type ReviewTake } from '../../src/shared/review'
import type { ItemEdit } from '../../src/main/sessions/edits'
import { events, frames, material, meta, transcript } from './fixtures'

/** 録画1本ぶんのレビュー（finishReview と同じ形） */
function baseRecord(edits: ItemEdit[] = []): SessionRecord {
  const stage = buildDraftDocument(material)
  const document = applyEdits({ document: stage.document, edits, events, frames }).document
  return { version: 1, meta, transcript, removedDuplicates: [], frames, draft: stage.draft.items,
    originalDocument: stage.document, document, edits, captureGaps: [] }
}

/** 追記する録画（その録画の開始からの時刻。ペンの ID は1本目と同じものを使う） */
function take(n: number, overrides: Partial<TakeMaterial> = {}): TakeMaterial {
  return {
    n,
    startedAt: '2026-10-02T11:00:00+09:00',
    addedAt: '2026-10-02T11:01:00+09:00',
    durationMs: 20_000,
    transcript: [{ t0: 3_000, t1: 5_000, speaker: 'self', text: 'ロゴの余白が狭いです', source: 'mic' }],
    removedDuplicates: [],
    events: [
      { t: 0, type: 'nav', url: 'http://localhost:3000/about', title: '会社概要' },
      { t: 8_000, type: 'pen', id: 'p3', t_end: 9_000, bbox: [1, 2, 3, 4], el: { selector: 'img.logo' } }
    ],
    frames: [{ t: 4_000, path: '00001.jpeg' }, { t: 9_100, path: '00002.jpeg', annotationId: 'p3' }],
    warnings: [],
    ...overrides
  }
}

describe('開いているレビューに録画を追記する', () => {
  it('既存の指摘の後ろに足し、ID はレビュー全体で重ならない', () => {
    const record = baseRecord()
    const before = record.document.items
    const { record: next, events: added } = appendTake(record, events, take(2))
    const ids = next.document.items.map((it) => it.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 既存の指摘はそのまま先頭に残る
    expect(next.document.items.slice(0, before.length).map((it) => [it.id, it.title, it.t])).toEqual(before.map((it) => [it.id, it.title, it.t]))
    const appended = next.document.items.slice(before.length)
    expect(appended.length).toBeGreaterThan(0)
    expect(appended.every((it) => it.id.startsWith('t2-'))).toBe(true)
    // ペンの ID も重ならない（1本目にも p3 がある）
    expect(added.filter((e) => e.type === 'pen').map((e) => e.type === 'pen' && e.id)).toEqual(['t2-p3'])
    expect(appended.flatMap((it) => it.annotationIds)).toContain('t2-p3')
    // 番号は通しで振り直される
    expect(next.document.items.map((it) => it.index)).toEqual(next.document.items.map((_, i) => i + 1))
  })

  it('追記した録画の中で動かした・元に戻した書き込みも、ID を付け替えて1本目の同じ ID と混ざらない', () => {
    const { events: added } = appendTake(baseRecord(), events, take(2, {
      events: [
        { t: 8_000, type: 'pen', id: 'p3', t_end: 9_000, bbox: [1, 2, 3, 4] },
        { t: 10_000, type: 'pen', id: 'p4', replaces: 'p3', t_end: 10_500, bbox: [50, 2, 3, 4] },
        { t: 12_000, type: 'pen', id: 'p5', t_end: 12_500, bbox: [1, 2, 3, 4] },
        { t: 13_000, type: 'erase', ids: ['p5'] }
      ]
    }))
    expect(added.map((e) => (e.type === 'pen' ? [e.id, e.replaces] : e.type === 'erase' ? e.ids : e.type))).toEqual([
      ['t2-p3', undefined], ['t2-p4', 't2-p3'], ['t2-p5', undefined], ['t2-p5']
    ])
  })

  it('時刻は前の長さ + 間隔だけずらし、静止画は takes/<n>/ を指す', () => {
    const { record: next } = appendTake(baseRecord(), events, take(2))
    const offset = meta.durationMs + TAKE_GAP_MS
    expect(next.takes).toEqual([{ n: 2, offsetMs: offset, durationMs: 20_000, startedAt: '2026-10-02T11:00:00+09:00', addedAt: '2026-10-02T11:01:00+09:00' }])
    expect(next.meta.durationMs).toBe(offset + 20_000)
    expect(next.frames.slice(frames.length)).toEqual([
      { t: offset + 4_000, path: 'takes/2/00001.jpeg' },
      { t: offset + 9_100, path: 'takes/2/00002.jpeg', annotationId: 't2-p3' }
    ])
    expect(next.transcript.at(-1)).toMatchObject({ t0: offset + 3_000, t1: offset + 5_000 })
    const appended = next.document.items.filter((it) => it.id.startsWith('t2-'))
    expect(appended.every((it) => it.t >= offset && it.frameTimes.every((ft) => ft >= offset))).toBe(true)
    // 追記した指摘の文脈（URL）は、その録画の遷移から引く
    expect(appended.find((it) => it.quotes.length > 0)?.context.url).toBe('http://localhost:3000/about')
  })

  it('既存の編集・全体への補足は残り、元に戻すと編集だけが戻って追記は残る', () => {
    const record = baseRecord()
    const [first, second] = record.document.items
    const edits: ItemEdit[] = [{ kind: 'text', id: first!.id, title: '直した見出し' }, { kind: 'delete', id: second!.id }, { kind: 'note', note: '全体メモ' }]
    const { record: next } = appendTake(baseRecord(edits), events, take(2))
    expect(next.edits).toEqual(edits)
    expect(next.document.note).toBe('全体メモ')
    expect(next.document.items.find((it) => it.id === first!.id)?.title).toBe('直した見出し')
    expect(next.document.items.some((it) => it.id === second!.id)).toBe(false)
    const addedIds = next.document.items.filter((it) => it.id.startsWith('t2-')).map((it) => it.id)
    expect(addedIds.length).toBeGreaterThan(0)

    // 元に戻す（review.ts と同じく、正本へ最後の1つを除いた編集を積み直す）
    const undone = applyEdits({ document: next.originalDocument!, edits: next.edits.slice(0, -1), events, frames: next.frames }).document
    expect(undone.note).toBeUndefined()
    expect(undone.items.filter((it) => it.id.startsWith('t2-')).map((it) => it.id)).toEqual(addedIds)
  })

  it('2本目・3本目と続けて足せる。番号は重ならない', () => {
    const once = appendTake(baseRecord(), events, take(2)).record
    expect(nextTakeNumber(once)).toBe(3)
    const twice = appendTake(once, events, take(3)).record
    const ids = twice.document.items.map((it) => it.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(twice.takes?.map((x) => x.n)).toEqual([2, 3])
    expect(twice.takes![1]!.offsetMs).toBe(once.meta.durationMs + TAKE_GAP_MS)
  })

  it('足した分は未整理として、整理をもう一度かけられるようにする', () => {
    const record = baseRecord()
    record.document = { ...record.document, organizedByLlm: true }
    record.originalDocument = { ...record.originalDocument!, organizedByLlm: true }
    expect(appendTake(record, events, take(2)).record.document.organizedByLlm).toBe(false)
  })

  it('正本の無い古いレビューにも、編集を二重にかけずに足せる', () => {
    const record = baseRecord()
    delete record.originalDocument
    const { record: next } = appendTake(record, events, take(2))
    expect(next.originalDocument).toBeUndefined()
    expect(next.document.items.slice(0, record.document.items.length).map((it) => it.id)).toEqual(record.document.items.map((it) => it.id))
  })

  it('話していない・何もしていない録画を足しても落ちない', () => {
    const { record: next } = appendTake(baseRecord(), events, take(2, { transcript: [], events: [], frames: [], durationMs: 0 }))
    expect(next.document.items.length).toBe(baseRecord().document.items.length)
    expect(next.takes).toHaveLength(1)
  })
})

describe('録画の一覧と、時刻から録画への対応', () => {
  it('追記の無い古いレビューは録画1本だけ', () => {
    expect(listTakes(baseRecord())).toEqual([{ n: 1, offsetMs: 0, durationMs: meta.durationMs, trim: null }])
    expect(nextTakeNumber(baseRecord())).toBe(2)
  })

  it('壊れた takes の記録は飛ばす', () => {
    const record = { ...baseRecord(), takes: [null, { n: 'x' }, { n: 2, offsetMs: 65_000, durationMs: 10_000, startedAt: '', addedAt: '2026-10-02T11:01:00Z' }] } as unknown as SessionRecord
    expect(listTakes(record).map((x) => x.n)).toEqual([1, 2])
  })

  it('指摘の時刻から、正しい録画とその中の時刻を引く', () => {
    const takes: ReviewTake[] = [{ n: 1, offsetMs: 0, durationMs: 60_000 }, { n: 2, offsetMs: 65_000, durationMs: 20_000, addedAt: '2026-10-02T11:01:00Z' }]
    expect(takeAt(takes, 12_000)?.n).toBe(1)
    expect(takeAt(takes, 65_000)?.n).toBe(2)
    expect(takeAt(takes, 70_000)).toMatchObject({ n: 2, offsetMs: 65_000 })
    expect(takeAt(undefined, 1_000)).toBeNull()
  })

  it('録画の境目（すき間を含む）で、録画とその中の時刻へ戻せる', () => {
    const { record: next } = appendTake(baseRecord(), events, take(2))
    const takes = listTakes(next)
    const offset = meta.durationMs + TAKE_GAP_MS
    expect(takes.map((x) => [x.n, x.offsetMs, x.durationMs])).toEqual([[1, 0, meta.durationMs], [2, offset, 20_000]])
    // 1本目の最後とすき間は1本目のもの。すき間に指摘は来ないが、来ても前の録画として扱う
    expect(takeAt(takes, meta.durationMs)?.n).toBe(1)
    expect(takeAt(takes, offset - 1)?.n).toBe(1)
    // 2本目の最初は2本目の 0ms
    const second = takeAt(takes, offset)!
    expect([second.n, offset - second.offsetMs]).toEqual([2, 0])
    // 足した指摘は、2本目の動画の中の元の時刻（話し始め 3秒）へ戻る
    const spoken = next.document.items.find((it) => it.id.startsWith('t2-') && it.quotes.length > 0)!
    const at = takeAt(takes, spoken.t)!
    expect([at.n, spoken.t - at.offsetMs]).toEqual([2, 3_000])
    // 静止画の差し替え候補も、境目のすぐ手前は1本目・すぐ後は2本目
    expect(framesOfTake(next, offset - 1).every((f) => !f.path.startsWith('takes/'))).toBe(true)
    expect(framesOfTake(next, offset).every((f) => f.path.startsWith('takes/2/'))).toBe(true)
  })

  it('整理が付けた名前は、指摘が増えたので外す', () => {
    const record = baseRecord()
    record.document = { ...record.document, reviewTitle: '料金ページの修正' }
    record.originalDocument = { ...record.originalDocument!, reviewTitle: '料金ページの修正' }
    const { record: next } = appendTake(record, events, take(2))
    expect(next.document.reviewTitle).toBeUndefined()
    expect(next.originalDocument?.reviewTitle).toBeUndefined()
  })

  it('追記した指摘の「未送信」の印は、送った時刻より後に足したものだけ', () => {
    const added: ReviewTake = { n: 2, offsetMs: 65_000, durationMs: 1, addedAt: '2026-10-02T11:01:00Z' }
    expect(isUnsentTake(added, undefined)).toBe(true)
    expect(isUnsentTake(added, '2026-10-02T11:00:00Z')).toBe(true)
    expect(isUnsentTake(added, '2026-10-02T11:05:00Z')).toBe(false)
    expect(isUnsentTake({ n: 1, offsetMs: 0, durationMs: 1 }, undefined)).toBe(false)
  })

  it('画像の差し替え候補は、同じ録画の静止画だけ', () => {
    const { record: next } = appendTake(baseRecord(), events, take(2))
    const offset = meta.durationMs + TAKE_GAP_MS
    expect(framesOfTake(next, 13_000).map((f) => f.path)).toEqual(frames.map((f) => f.path))
    expect(framesOfTake(next, offset + 4_000).map((f) => f.path)).toEqual(['takes/2/00001.jpeg', 'takes/2/00002.jpeg'])
  })

  it('静止画のパスは録画ごとのフォルダへ解決する', () => {
    const paths = sessionPaths('/p', '20261002-104012', '.ferret')
    expect(takePaths(paths, 1)).toBe(paths)
    expect(takePaths(paths, 2).recording).toBe(join(paths.dir, 'takes', '2', 'recording.webm'))
    expect(takePaths(paths, 2).relativeDir).toBe(paths.relativeDir)
    expect(frameFilePath(paths, '00003.jpeg')).toBe(join(paths.framesDir, '00003.jpeg'))
    expect(frameFilePath(paths, 'takes/2/00003.jpeg')).toBe(join(paths.dir, 'takes', '2', 'work', 'frames', '00003.jpeg'))
    // 想定外の形（上のフォルダへ出る）はファイル名だけを使う
    expect(frameFilePath(paths, 'takes/2/../../x.png')).toBe(join(paths.framesDir, 'x.png'))
  })
})
