import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import { applyEdits, type ItemEdit } from '../../src/main/sessions/edits'
import { sessionRecordProblem } from '../../src/main/sessions/limits'
import { appendNote, hasRecordedItems, isTypedItem, keepTypedItems, newNoteId, newNoteRecord, noteTime, sanitizeTextNote, typedCount, withoutNotes, type NoteInput } from '../../src/main/sessions/notes'
import type { SessionRecord } from '../../src/main/sessions/store'
import { appendTake } from '../../src/main/sessions/takes'
import { ViewInputGrant } from '../../src/main/captureConsent'
import { MAX_NOTE_TEXT, NOTE_ID_PREFIX, noteBoxFromClick, noteEditorPosition, noteKeyAction, noteTitle, normalizeNoteText } from '../../src/shared/textNote'
import { events, frames, material, meta, transcript } from './fixtures'

const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

/** 録画1本ぶんのレビュー（finishReview と同じ形） */
function recorded(edits: ItemEdit[] = []): SessionRecord {
  const stage = buildDraftDocument(material)
  const document = applyEdits({ document: stage.document, edits, events, frames }).document
  return { version: 1, meta, transcript, removedDuplicates: [], frames, draft: stage.draft.items,
    originalDocument: stage.document, document, edits, captureGaps: [] }
}

function input(id: string, text = 'ボタンの色を濃くして\n2行目の補足', page: NoteInput['page'] | null = { url: 'http://localhost:3000/pricing', title: '料金' }): NoteInput {
  return { id, note: { text, bbox: [10, 20, 120, 40], view: { width: 1280, height: 800 }, el: { selector: 'button.buy', text: '購入する' } },
    frame: { path: `${id}.png`, size: { width: 2560, height: 1600 } }, ...(page ? { page } : {}) }
}

describe('文字で指摘: 欄のキー（IME で誤送信しない）', () => {
  it('Enter で足す・Shift+Enter で改行・Esc で取り消す', () => {
    expect(noteKeyAction({ key: 'Enter' })).toBe('submit')
    expect(noteKeyAction({ key: 'Enter', shiftKey: true })).toBe('newline')
    expect(noteKeyAction({ key: 'Enter', altKey: true })).toBe('newline')
    expect(noteKeyAction({ key: 'Escape' })).toBe('cancel')
    expect(noteKeyAction({ key: 'a' })).toBeNull()
  })

  it('変換中（isComposing・keyCode 229）の Enter・Esc では何もしない', () => {
    expect(noteKeyAction({ key: 'Enter', isComposing: true })).toBeNull()
    expect(noteKeyAction({ key: 'Enter', keyCode: 229 })).toBeNull()
    expect(noteKeyAction({ key: 'Escape', isComposing: true })).toBeNull()
  })
})

describe('文字で指摘: 文・見出し・枠', () => {
  it('文は前後の空白を落として上限で切り、空なら null', () => {
    expect(normalizeNoteText('  直して \r\n ')).toBe('直して')
    expect(normalizeNoteText('   ')).toBeNull()
    expect(normalizeNoteText(42)).toBeNull()
    expect(normalizeNoteText('あ'.repeat(MAX_NOTE_TEXT + 50))!.length).toBe(MAX_NOTE_TEXT)
  })

  it('見出しは最初の空でない行を40文字で切る', () => {
    expect(noteTitle('\n\n  見出しの行  \n本文')).toBe('見出しの行')
    expect(noteTitle('あ'.repeat(50))).toBe(`${'あ'.repeat(40)}…`)
  })

  it('クリックだけなら、ほどよい大きさの要素を囲み、大きすぎる要素ではクリックした所に小さな枠を置く', () => {
    const view = { width: 1000, height: 800 }
    expect(noteBoxFromClick(500, 400, view, { x: 100, y: 100, width: 200, height: 40 })).toEqual([97, 97, 206, 46])
    expect(noteBoxFromClick(500, 400, view, { x: 0, y: 0, width: 1000, height: 800 })).toEqual([420, 350, 160, 100])
    // 端では画面の中に収める
    expect(noteBoxFromClick(5, 5, view, null)).toEqual([0, 0, 85, 55])
  })

  it('欄は枠の下、入らなければ上に置く', () => {
    const view = { width: 1000, height: 800 }
    expect(noteEditorPosition([100, 100, 200, 50], view, { width: 300, height: 112 })).toEqual({ left: 100, top: 158 })
    expect(noteEditorPosition([100, 650, 200, 100], view, { width: 300, height: 112 })).toEqual({ left: 100, top: 530 })
    expect(noteEditorPosition([900, 100, 50, 50], view, { width: 300, height: 112 }).left).toBe(692)
  })
})

describe('文字で指摘: 注入スクリプトから届いた値を確かめる', () => {
  it('形の合う値だけ通し、文・座標・要素を整える', () => {
    const note = sanitizeTextNote({ text: '  余白を広げて ', bbox: [1.4, 2.6, 300, 40], view: { width: 1280, height: 800 }, el: { selector: 'x'.repeat(500), text: '購入' }, extra: 1 })
    expect(note).toEqual({ text: '余白を広げて', bbox: [1, 3, 300, 40], view: { width: 1280, height: 800 }, el: { selector: 'x'.repeat(300), text: '購入' } })
  })

  it('入力欄を指したときは文字を持たない', () => {
    expect(sanitizeTextNote({ text: 'a', bbox: [0, 0, 5, 5], el: { selector: 'input', text: 'secret', sensitive: true } })?.el).toEqual({ selector: 'input', sensitive: true })
  })

  it('空の文・壊れた枠・巨大な文は捨て、長い文は上限で切る', () => {
    expect(sanitizeTextNote(null)).toBeNull()
    expect(sanitizeTextNote({ text: '  ', bbox: [0, 0, 5, 5] })).toBeNull()
    expect(sanitizeTextNote({ text: 'a', bbox: [0, 0, 5] })).toBeNull()
    expect(sanitizeTextNote({ text: 'a', bbox: [0, 0, 0, 5] })).toBeNull()
    expect(sanitizeTextNote({ text: 'a', bbox: [0, 0, Number.NaN, 5] })).toBeNull()
    expect(sanitizeTextNote({ text: 'a'.repeat(MAX_NOTE_TEXT * 5), bbox: [0, 0, 5, 5] })).toBeNull()
    expect(sanitizeTextNote({ text: 'a'.repeat(MAX_NOTE_TEXT + 10), bbox: [0, 0, 5, 5] })?.text.length).toBe(MAX_NOTE_TEXT)
    expect(sanitizeTextNote({ text: 'a', bbox: [0, 0, 5, 5], view: { width: -1, height: 2 } })?.view).toBeUndefined()
  })

  it('ID は note- で始まる', () => {
    expect(newNoteId(() => 'abc', () => 36)).toBe(`${NOTE_ID_PREFIX}10abc`)
  })
})

describe('文字で指摘: 録画しないで始めるレビュー', () => {
  it('打った文の指摘1件と静止画1枚・nav と枠の操作ログを作り、記録の確かめを通る', () => {
    const { record, events: added } = newNoteRecord({ id: '20261003-101500', startedAt: '2026-10-03T01:15:00.000Z' }, input('note-a1'))
    expect(sessionRecordProblem(record)).toBeNull()
    expect(record.meta).toMatchObject({ durationMs: 0, twoSpeakers: false, targetUrl: 'http://localhost:3000/pricing' })
    expect(record.frames).toEqual([{ t: 0, path: 'note-a1.png', annotationId: 'note-a1', size: { width: 2560, height: 1600 } }])
    expect(added.map((e) => e.type)).toEqual(['nav', 'pen'])
    const [item] = record.document.items
    expect(item).toMatchObject({ id: 'note-a1', index: 1, title: 'ボタンの色を濃くして', request: 'ボタンの色を濃くして\n2行目の補足', status: 'decided', include: true,
      images: ['./01.png'], frameTimes: [0], annotationIds: ['note-a1'] })
    expect(item!.quotes).toEqual([{ source: 'text', speaker: 'self', t: 0, text: 'ボタンの色を濃くして\n2行目の補足' }])
    // URL・題名・指した要素は録画と同じ仕組み（buildItemContext）で引く
    expect(item!.context).toMatchObject({ url: 'http://localhost:3000/pricing', title: '料金', element: { selector: 'button.buy', text: '購入する' } })
    expect(isTypedItem(item!)).toBe(true)
    expect(record.originalDocument).toEqual(record.document)
  })

  it('映したウインドウ（ページが無い）では nav を足さず URL を持たない', () => {
    const { record, events: added } = newNoteRecord({ id: '20261003-101500', startedAt: '2026-10-03T01:15:00.000Z' }, input('note-w1', '閉じるボタンが小さい', null), ['window gap'])
    expect(added.map((e) => e.type)).toEqual(['pen'])
    expect(record.meta.targetUrl).toBeUndefined()
    expect(record.document.items[0]!.context.url).toBeUndefined()
    expect(record.captureGaps).toEqual(['window gap'])
  })

  it('続けて足すと時刻をずらして並べ、番号と画像名を振り直す', () => {
    const first = newNoteRecord({ id: '20261003-101500', startedAt: '2026-10-03T01:15:00.000Z' }, input('note-a1'))
    const second = appendNote(first.record, first.events, input('note-a2', '見出しを太く'))
    expect(second.record.document.items.map((it) => [it.id, it.t, it.index, it.images])).toEqual([
      ['note-a1', 0, 1, ['./01.png']],
      ['note-a2', 1, 2, ['./02.png']]
    ])
    expect(typedCount(second.record.document)).toBe(2)
    expect(hasRecordedItems(second.record.document)).toBe(false)
  })
})

describe('文字で指摘: 開いているレビューへ足す', () => {
  it('録画の末尾の後ろに足し、既存の指摘・編集はそのまま。正本にも入る', () => {
    const base = recorded()
    const target = base.document.items[0]!
    const edits: ItemEdit[] = [{ kind: 'text', id: target.id, title: '直した見出し' }]
    const record = recorded(edits)
    const { record: next, events: added } = appendNote(record, events, input('note-b1'))
    expect(sessionRecordProblem(next)).toBeNull()
    const t = noteTime(record, events)
    expect(t).toBeGreaterThanOrEqual(meta.durationMs)
    expect(added.every((e) => e.t === t)).toBe(true)
    expect(next.meta).toEqual(record.meta)
    expect(next.document.items.find((it) => it.id === target.id)?.title).toBe('直した見出し')
    expect(next.document.items.at(-1)).toMatchObject({ id: 'note-b1', t, frameTimes: [t] })
    expect(next.originalDocument!.items.some((it) => it.id === 'note-b1')).toBe(true)
    expect(next.frames.at(-1)).toEqual({ t, path: 'note-b1.png', annotationId: 'note-b1', size: { width: 2560, height: 1600 } })
    expect(next.edits).toEqual(edits)
  })

  it('後の編集を元に戻しても、打った指摘は消えない', () => {
    const { record: next, events: added } = appendNote(recorded(), events, input('note-b1'))
    const allEvents = [...events, ...added]
    const edit: ItemEdit = { kind: 'delete', id: next.document.items[0]!.id }
    const edited = applyEdits({ document: next.originalDocument!, edits: [edit], events: allEvents, frames: next.frames }).document
    const undone = applyEdits({ document: next.originalDocument!, edits: [], events: allEvents, frames: next.frames }).document
    expect(edited.items.some((it) => it.id === 'note-b1')).toBe(true)
    expect(undone.items.some((it) => it.id === 'note-b1')).toBe(true)
  })

  it('同じ ID の指摘があれば別の ID にする', () => {
    const once = appendNote(recorded(), events, input('note-b1'))
    const twice = appendNote(once.record, [...events, ...once.events], input('note-b1'))
    const ids = twice.record.document.items.map((it) => it.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('その後に録画を追記しても、打った指摘は残る', () => {
    const { record: next, events: added } = appendNote(recorded(), events, input('note-b1'))
    const { record: withTake } = appendTake(next, [...events, ...added], { n: 2, startedAt: '2026-10-03T02:00:00.000Z', addedAt: '2026-10-03T02:01:00.000Z',
      durationMs: 10_000, transcript: [{ t0: 1_000, t1: 2_000, speaker: 'self', text: 'フッターの色', source: 'mic' }], removedDuplicates: [], events: [], frames: [], warnings: [] })
    expect(withTake.document.items.filter(isTypedItem).map((it) => it.id)).toEqual(['note-b1'])
  })
})

describe('文字で指摘: 整理（LLM）で失わない', () => {
  it('整理の素材から打った指摘の枠・静止画を外し、整理の後に1件だけ足し直す', () => {
    const { record: next, events: added } = appendNote(recorded(), events, input('note-c1'))
    const allEvents = [...events, ...added].sort((a, b) => a.t - b.t)
    const full = { meta: next.meta, transcript: next.transcript, events: allEvents, frames: next.frames }
    // 外さないと、枠だけの指摘が整理の下書きに混ざる
    expect(buildDraftDocument(full).draft.items.some((d) => d.annotationIds.includes('note-c1'))).toBe(true)
    const material = withoutNotes(full)
    expect(material.events.some((e) => e.type === 'pen' && e.id === 'note-c1')).toBe(false)
    expect(material.frames.some((f) => f.annotationId === 'note-c1')).toBe(false)
    const organized = { ...buildDraftDocument(material).document, organizedByLlm: true }
    expect(organized.items.some((it) => it.annotationIds.includes('note-c1'))).toBe(false)
    const kept = keepTypedItems(next.document, organized, allEvents)
    expect(kept.items.filter(isTypedItem).map((it) => [it.id, it.request])).toEqual([['note-c1', 'ボタンの色を濃くして\n2行目の補足']])
    expect(kept.items.length).toBe(organized.items.length + 1)
    expect(kept.items.map((it) => it.index)).toEqual(kept.items.map((_, i) => i + 1))
    expect(kept.organizedByLlm).toBe(true)
  })

  it('打った指摘だけのレビューは整理の対象にしない（canOrganize）', () => {
    expect(hasRecordedItems(recorded().document)).toBe(true)
    const { record } = newNoteRecord({ id: '20261003-101500', startedAt: '2026-10-03T01:15:00.000Z' }, input('note-a1'))
    expect(hasRecordedItems(record.document)).toBe(false)
    expect(read('src/main/review.ts')).toMatch(/canOrganize: record\.edits\.length === 0 && hasRecordedItems\(record\.document\)/)
  })

  it('廃止した「画面に置いたテキスト」の古い引用は、打った指摘として数えない', () => {
    expect(isTypedItem({ quotes: [{ source: 'text', speaker: 'self', t: 0, text: 'x' }], annotationIds: ['t1'] })).toBe(false)
  })
})

describe('文字で指摘: 静止画はそのビューへの本物の入力の直後に1回だけ', () => {
  it('入力のあったビューだけ・時間内・1回きり', () => {
    let now = 1_000
    const grant = new ViewInputGrant<object>(5_000, () => now)
    const browser = {}
    const mirror = {}
    expect(grant.consume(browser)).toBe(false)
    grant.sawInput(browser)
    expect(grant.consume(mirror)).toBe(false)
    expect(grant.consume(browser)).toBe(true)
    expect(grant.consume(browser)).toBe(false)
    grant.sawInput(mirror)
    now += 5_001
    expect(grant.consume(mirror)).toBe(false)
  })

  it('index.ts は許可を使ってから撮り、許可はビューの input-event からだけ付ける', () => {
    const main = read('src/main/index.ts')
    const start = main.indexOf('capture: async (view) => {')
    expect(start).toBeGreaterThan(0)
    const block = main.slice(start, main.indexOf('capturePage()', start))
    expect(block).toMatch(/if \(!noteInputs\.consume\(view\)\) return false/)
    expect(main).toMatch(/browser\.onPageInput = \(contents\) => noteInputs\.sawInput\(contents\)/)
    expect((main.match(/noteInputs\.sawInput\(/g) ?? []).length).toBe(1)
    const browser = read('src/main/browser.ts')
    expect((browser.match(/this\.onPageInput\?\.\(wc\)/g) ?? []).length).toBe(2)
    expect(browser).toMatch(/if \(isGestureInput\(input\.type\)\) this\.onPageInput\?\.\(wc\)/)
  })

  it('受け口は見えているビューから・入のときだけ受け、値を確かめてから撮る', () => {
    const src = read('src/main/textNotes.ts')
    expect(src).toMatch(/if \(!this\.active \|\| this\.deps\.recording\(\) \|\| sender !== this\.current\(\)\)/)
    expect(src.indexOf('sanitizeTextNote(raw)')).toBeLessThan(src.indexOf('this.deps.capture(sender)'))
  })

  it('注入スクリプトは本物のキー・クリックだけで足し、IME の変換中は送らない', () => {
    const preload = read('src/preload/review.ts')
    expect(preload).toMatch(/input\.addEventListener\('keydown', \(event\) => \{\n\s+\/\/[^\n]*\n\s+if \(!event\.isTrusted\) return\n\s+const action = noteKeyAction\(event\)/)
    expect(preload).toMatch(/add\.addEventListener\('click', \(event\) => \{\n\s+if \(!event\.isTrusted\) return/)
    expect(preload).toMatch(/function notePointerDown\(event: PointerEvent\): void \{\n\s+if \(!event\.isTrusted/)
  })
})
