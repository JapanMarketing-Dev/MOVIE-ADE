/**
 * 文字で指摘（エディタで枠を引いて指示を打つ。録画しない）を、レビューの記録へ足す。
 *
 * 打った指摘は「書き込み（pen）1本 + 静止画1枚 + 打った文」の指摘として持つ。
 * - 操作ログ（events.jsonl）には、そのページの nav と、枠の pen（ID は note- で始まる）を足す。要素・URL の文脈は録画と同じく buildItemContext が引く
 * - 静止画は work/frames に置き、frames に annotationId 付きで足す（画像の名前は persist が 01.png… に振る）
 * - 引用は source: 'text'（確認画面は「打った」、feedback.md は「書き込み」として出す）
 * - 正本（originalDocument）に足し、編集はその上に積み直す（元に戻すで消えない）
 * - 整理（LLM）は録画の素材から下書きを作り直すので、打った指摘・その枠・その静止画は素材から外し、整理の後に足し直す（keepTypedItems）
 *
 * Electron に依存しない純粋な処理だけを置く（単体テストから使う）。ファイルの読み書きは src/main/review.ts。
 */
import { MAX_NOTE_TEXT, NOTE_ID_PREFIX, normalizeNoteText, noteTitle } from '@shared/textNote'
import { finalizeItems, toPending, type PendingItem } from '../pipeline/assemble'
import type { ElementRef, Event, FeedbackDocument, FeedbackItem, FrameRef, Material, SessionMeta } from '../pipeline/types'
import { sanitizeElement } from '../recording/events'
import { applyEdits } from './edits'
import { maxOf } from './limits'
import type { SessionRecord } from './store'

/** 注入スクリプトから届いた指示を確かめた形 */
export interface TextNote {
  text: string
  /** 枠 [x, y, w, h]（ビューの CSS ピクセル） */
  bbox: [number, number, number, number]
  view?: { width: number; height: number }
  el?: ElementRef
}

/** 指摘を足すページ。内蔵ブラウザなら URL と題名、映したウインドウなら無し（録画と同じく URL を持たない） */
export interface NotePage {
  url: string
  title: string
}

const MAX_COORDINATE = 100_000

/**
 * 注入スクリプトから届いた値を確かめる（ページの中で動くので、形の合わない値・巨大な文を信じない）。
 * 文は MAX_NOTE_TEXT で切り、空なら null
 */
export function sanitizeTextNote(raw: unknown): TextNote | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as { text?: unknown; bbox?: unknown; view?: unknown; el?: unknown }
  // 長すぎる文は切る前に断る（巨大な文字列を正規化しない）
  if (typeof value.text !== 'string' || value.text.length > MAX_NOTE_TEXT * 4) return null
  const text = normalizeNoteText(value.text)
  if (!text) return null
  if (!Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, w, h] = (value.bbox as number[]).map((n) => Math.round(Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, n))))
  if (w! <= 0 || h! <= 0) return null
  const v = value.view as { width?: unknown; height?: unknown } | null | undefined
  const size = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_COORDINATE
  const view = v && size(v.width) && size(v.height) ? { width: Math.round(v.width), height: Math.round(v.height) } : undefined
  const el = sanitizeElement(value.el)
  return { text, bbox: [x!, y!, w!, h!], ...(view ? { view } : {}), ...(el ? { el } : {}) }
}

const isNoteId = (id: string | undefined): boolean => typeof id === 'string' && id.startsWith(NOTE_ID_PREFIX)

/**
 * 文字で指摘した指摘か（打った文の引用と、note- の枠を持つ）。
 * 廃止した「画面に置いたテキスト」の引用（古いレビュー）は枠の ID が違うので含めない
 */
export function isTypedItem(item: Pick<FeedbackItem, 'quotes' | 'annotationIds'>): boolean {
  return item.quotes.some((q) => q.source === 'text') && (item.annotationIds ?? []).some(isNoteId)
}

/** 打った指摘の枠・静止画を除いた素材（整理の入力）。録画の発話・書き込みからだけ下書きを作る */
export function withoutNotes(material: Material): Material {
  return {
    ...material,
    events: material.events.filter((e) => !(e.type === 'pen' && isNoteId(e.id))),
    frames: material.frames.filter((f) => !isNoteId(f.annotationId))
  }
}

/**
 * 整理の後、整理の前にあった打った指摘を足し直す（整理は録画の素材だけから作り直すので、打った指摘はそこに無い）
 */
export function keepTypedItems(previous: FeedbackDocument, organized: FeedbackDocument, events: Event[]): FeedbackDocument {
  const typed = previous.items.filter(isTypedItem)
  if (!typed.length) return organized
  const taken = new Set(organized.items.map((it) => it.id))
  const kept = typed.map((it) => ({ ...toPending(it), id: uniqueId(it.id, taken) }))
  return { ...organized, items: finalizeItems([...organized.items.map(toPending), ...kept], events, {}, organized.customOrder === true) }
}

function uniqueId(id: string, taken: Set<string>): string {
  let out = id
  for (let i = 2; taken.has(out); i++) out = `${id}-${i}`
  taken.add(out)
  return out
}

/**
 * 打った指摘の時刻。録画の末尾（meta.durationMs）より前にはしない。前の指摘・静止画・操作と重ならないよう、いちばん後ろの次の ms にする
 */
export function noteTime(record: Pick<SessionRecord, 'meta' | 'frames'>, events: Event[]): number {
  const last = maxOf([...record.frames.map((f) => f.t), ...events.map((e) => e.t)], -1)
  return Math.max(Math.max(0, record.meta.durationMs), last + 1)
}

/** 新しい書き込みの ID（静止画の名前にも使う） */
export function newNoteId(random: () => string = () => Math.random().toString(36).slice(2, 8), now: () => number = Date.now): string {
  return `${NOTE_ID_PREFIX}${now().toString(36)}${random()}`
}

/** 打った指摘1件を足すための材料 */
export interface NoteInput {
  id: string
  note: TextNote
  /** 静止画（work/frames のファイル名と大きさ）。撮れなければ無し（画像の無い指摘になる） */
  frame?: { path: string; size?: { width: number; height: number } }
  /** 内蔵ブラウザのページ。映したウインドウなら無し */
  page?: NotePage
}

/** 打った指摘を時刻 t に置いたときの操作ログ（そのページの nav と、枠の pen） */
export function noteEvents(t: number, input: NoteInput): Event[] {
  const nav: Event[] = input.page ? [{ t, type: 'nav', url: input.page.url, title: input.page.title }] : []
  const pen: Event = { t, type: 'pen', id: input.id, t_end: t, bbox: input.note.bbox, shape: 'rect',
    ...(input.note.view ? { view: input.note.view } : {}), ...(input.note.el ? { el: input.note.el } : {}) }
  return [...nav, pen]
}

function notePending(t: number, input: NoteInput, id: string): PendingItem {
  return {
    id,
    t,
    title: noteTitle(input.note.text),
    request: input.note.text,
    status: 'decided',
    quotes: [{ source: 'text', speaker: 'self', t, text: input.note.text }],
    frameTimes: input.frame ? [t] : [],
    annotationIds: [input.id],
    draftIds: [],
    include: true
  }
}

function noteFrame(t: number, input: NoteInput): FrameRef[] {
  return input.frame ? [{ t, path: input.frame.path, annotationId: input.id, ...(input.frame.size ? { size: input.frame.size } : {}) }] : []
}

/** 録画しないで始めるレビュー（最初の1件が打った指摘） */
export function newNoteRecord(meta: Omit<SessionMeta, 'durationMs' | 'twoSpeakers' | 'targetUrl'>, input: NoteInput, captureGaps: string[] = []): { record: SessionRecord; events: Event[] } {
  const t = 0
  const events = noteEvents(t, input)
  const fullMeta: SessionMeta = { ...meta, durationMs: 0, twoSpeakers: false, ...(input.page ? { targetUrl: input.page.url } : {}) }
  const document: FeedbackDocument = { meta: fullMeta, items: finalizeItems([notePending(t, input, input.id)], events), dropped: [], organizedByLlm: false }
  return {
    events,
    record: { version: 1, meta: fullMeta, transcript: [], removedDuplicates: [], frames: noteFrame(t, input), draft: [],
      originalDocument: document, document, edits: [], captureGaps }
  }
}

/**
 * 開いているレビューの末尾に打った指摘を足す。既存の指摘・編集・全体への補足・進み具合は残す。
 * 正本に足して編集を積み直す（正本の無い古いレビューは、今の一覧へそのまま足す）
 */
export function appendNote(record: SessionRecord, existingEvents: Event[], input: NoteInput): { record: SessionRecord; events: Event[] } {
  const t = noteTime(record, existingEvents)
  const events = noteEvents(t, input)
  const allEvents = [...existingEvents, ...events].sort((a, b) => a.t - b.t)
  const frames = [...record.frames, ...noteFrame(t, input)]
  const base = record.originalDocument ?? record.document
  const id = uniqueId(input.id, new Set([...base.items, ...record.document.items].map((it) => it.id)))
  const added = notePending(t, input, id)
  // 整理が付けた名前（reviewTitle）は足した指摘を含まないので外す（自動の名前はルールで作り直す）。整理し直せるよう organizedByLlm は変えない
  const extend = ({ reviewTitle: _stale, ...doc }: FeedbackDocument): FeedbackDocument => ({ ...doc,
    items: finalizeItems([...doc.items.map(toPending), added], allEvents, {}, doc.customOrder === true) })
  const originalDocument = record.originalDocument ? extend(record.originalDocument) : undefined
  const document = originalDocument
    ? applyEdits({ document: originalDocument, edits: record.edits, events: allEvents, frames }).document
    : extend(record.document)
  return { events, record: { ...record, frames, ...(originalDocument ? { originalDocument } : {}), document } }
}

/** レビューの中の打った指摘の数（「指摘に足しました」の件数） */
export function typedCount(document: FeedbackDocument): number {
  return document.items.filter(isTypedItem).length
}

/** 整理をかける意味があるか（録画の指摘が1件でもある）。打った指摘だけのレビューは整理しない */
export function hasRecordedItems(document: FeedbackDocument): boolean {
  return document.items.some((it) => !isTypedItem(it))
}
