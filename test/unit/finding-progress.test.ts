import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyProgress,
  countProgress,
  nextProgress,
  normalizeProgress,
  parseProgress,
  progressChangedIds,
  PROGRESS_NOTE_MAX,
  sentPatch,
  serializeProgress
} from '@shared/findingProgress'
import { REPLY_MAX, renderAgentPrompt, renderReplyPrompt } from '@shared/agentPrompt'
import { fitsSingleWrite, sanitizePastePayload } from '../../src/main/agent/sanitize'
import { appendEvents, createSession, listSessions, readProgress, saveSession, updateProgress, type SessionRecord } from '../../src/main/sessions/index'
import { buildStoredSummary, parseStoredSummary } from '../../src/main/sessions/summary'
import { assembleFromOrganized } from '../../src/main/pipeline/assemble'
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback'
import { events, material } from './fixtures'

/**
 * 指摘ごとの進み具合（progress.json）。Agent と利用者のどちらも書き、Findings とサイドバーに出す。
 */

describe('progress.json の読み方', () => {
  it('書き方の揺れを吸収し、知らない値は捨てる', () => {
    expect(normalizeProgress('In Progress')).toBe('in_progress')
    expect(normalizeProgress('in-progress')).toBe('in_progress')
    expect(normalizeProgress(' DONE ')).toBe('done')
    expect(normalizeProgress('todo')).toBe('todo')
    expect(normalizeProgress('finished')).toBeNull()
    expect(normalizeProgress(1)).toBeNull()
  })

  it('壊れた中身は空として読み、todo と知らない値は持たない', () => {
    for (const raw of [null, 'x', 42, ['a'], undefined]) expect(parseProgress(raw)).toEqual({})
    expect(parseProgress({ a: 'done', b: 'in_progress', c: 'todo', d: 'wip', e: null, '': 'done', f: ['done'], g: { note: '状態が無い' } }))
      .toEqual({ a: { status: 'done' }, b: { status: 'in_progress' } })
  })

  it('文字列だけの古い形と、理由つきの新しい形のどちらも読む', () => {
    expect(parseProgress({
      i1: 'done',
      i2: { status: 'needs_human', note: '  録画の Sign up ボタンは今のコードに無い  ' },
      i3: { status: 'Needs Human' },
      i4: { status: 'in_progress', reply: 'ヘッダーに置く', note: 42 },
      i5: { status: 'bogus', note: 'x' }
    })).toEqual({
      i1: { status: 'done' },
      i2: { status: 'needs_human', note: '録画の Sign up ボタンは今のコードに無い' },
      i3: { status: 'needs_human' },
      i4: { status: 'in_progress', reply: 'ヘッダーに置く' }
    })
    expect(normalizeProgress('needs-human')).toBe('needs_human')
  })

  it('理由・返答は長すぎれば切る', () => {
    const long = 'あ'.repeat(PROGRESS_NOTE_MAX + 50)
    expect(parseProgress({ a: { status: 'needs_human', note: long } }).a?.note).toHaveLength(PROGRESS_NOTE_MAX)
  })

  it('knownIds を渡すと、そのレビューに無い指摘のIDを落とす', () => {
    expect(parseProgress({ a: 'done', ghost: 'done' }, ['a', 'b'])).toEqual({ a: { status: 'done' } })
  })

  it('変更を重ねる。todo は消し、読めない値は無視し、状態を変えると古い理由は消える', () => {
    expect(applyProgress({ a: { status: 'done' }, b: { status: 'in_progress' }, d: { status: 'needs_human', note: '古い' } },
      { a: 'todo', c: 'done', b: 'nope' as never, d: { status: 'in_progress', reply: '新しい /pricing に合わせる' } }))
      .toEqual({ b: { status: 'in_progress' }, c: { status: 'done' }, d: { status: 'in_progress', reply: '新しい /pricing に合わせる' } })
    expect(applyProgress({ a: { status: 'done' } }, { a: { status: 'todo' } })).toEqual({})
  })

  it('ファイルへは、理由・返答が無ければ文字列だけで書く（Agent が読み書きしやすい形）', () => {
    expect(serializeProgress({ a: { status: 'done' }, b: { status: 'needs_human', note: 'n' } })).toEqual({ a: 'done', b: { status: 'needs_human', note: 'n' } })
  })

  it('ボタンは 未対応 → 対応中 → 完了 → 未対応。確認待ちは対応中へ', () => {
    expect(nextProgress('todo')).toBe('in_progress')
    expect(nextProgress('in_progress')).toBe('done')
    expect(nextProgress('done')).toBe('todo')
    expect(nextProgress('needs_human')).toBe('in_progress')
  })
})

describe('集計', () => {
  const items = [
    { id: 'a', include: true },
    { id: 'b', include: true },
    { id: 'c', include: false },
    { id: 'd', include: true }
  ]

  it('Agent へ送る指摘（include=true）だけを数える。確認待ちも数える', () => {
    expect(countProgress(items, { a: { status: 'done' }, b: { status: 'in_progress' }, c: { status: 'needs_human' }, d: { status: 'needs_human', note: 'x' } }))
      .toEqual({ done: 1, inProgress: 1, needsHuman: 1, total: 3 })
    expect(countProgress(items, undefined)).toEqual({ done: 0, inProgress: 0, needsHuman: 0, total: 3 })
  })

  it('送信したら、送った指摘の未対応だけを対応中にする（完了・確認待ちは変えない・外した指摘は触らない）', () => {
    expect(sentPatch(items, { a: { status: 'done' }, d: { status: 'needs_human' } })).toEqual({ b: 'in_progress' })
  })

  it('変更の通知から、進み具合が変わったレビューのIDを拾う', () => {
    expect(progressChangedIds([
      '.ferret/reviews/20261003-101500/progress.json',
      '.ade-movie/reviews/20261002-090000/progress.json',
      '.ferret/reviews/20261003-101500/progress.json.tmp',
      '.ferret/reviews/20261003-101500/feedback.md',
      'src/progress.json'
    ])).toEqual(['20261003-101500', '20261002-090000'])
    expect(progressChangedIds(['.ferret\\reviews\\20261003-101500\\progress.json'])).toEqual(['20261003-101500'])
  })
})

const organized = {
  items: [
    { title: '見出しが小さい', request: '大きくする', status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 2_000, text: 'この見出しが小さいですね' }], frame_times: [3_000], annotation_ids: [] as string[] },
    { title: 'ボタンの色', request: '青にする', status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 5_000, text: 'ボタンを青に' }], frame_times: [5_000], annotation_ids: [] as string[] }
  ],
  dropped: []
}
const record = (): SessionRecord => ({
  version: 1, meta: material.meta, transcript: material.transcript, removedDuplicates: [], frames: material.frames,
  draft: [], document: assembleFromOrganized(material, organized), edits: []
})

describe('progress.json の読み書きと一覧の完了数', () => {
  let project: string
  beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'ade-progress-')) })
  afterEach(async () => { await rm(project, { recursive: true, force: true }) })

  async function saved(edit?: (r: SessionRecord) => void) {
    const p = await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
    await appendEvents(p, events)
    const r = record()
    edit?.(r)
    await saveSession(p, r)
    return { p, r }
  }

  it('無い・壊れた progress.json は未対応として読み、落ちない', async () => {
    const { p } = await saved()
    expect(await readProgress(p)).toEqual({})
    await writeFile(p.progressJson, '{ "a": "done", ')
    expect(await readProgress(p)).toEqual({})
    const [summary] = await listSessions(project)
    expect(summary?.doneCount).toBe(0)
  })

  it('利用者の変更は Agent の書いた分を消さずに重ねる', async () => {
    const { p, r } = await saved()
    const [a, b] = r.document.items
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: { status: 'needs_human', note: '録画が古い' }, other: 'done' }))
    expect(await updateProgress(p, { [b!.id]: 'done' })).toEqual({ [a!.id]: { status: 'needs_human', note: '録画が古い' }, other: { status: 'done' }, [b!.id]: { status: 'done' } })
    expect(JSON.parse(await readFile(p.progressJson, 'utf8'))).toEqual({ [a!.id]: { status: 'needs_human', note: '録画が古い' }, other: 'done', [b!.id]: 'done' })
    // 返答して送り直したら、対応中に戻して返答を残す
    await updateProgress(p, { [a!.id]: { status: 'in_progress', reply: '新しい作りに合わせる' } })
    expect(await readProgress(p, [a!.id, b!.id])).toEqual({ [a!.id]: { status: 'in_progress', reply: '新しい作りに合わせる' }, [b!.id]: { status: 'done' } })
  })

  it('一覧は 完了数/対象数 を返す。Send to Agent から外した指摘は数えない', async () => {
    const { p, r } = await saved((rec) => { rec.document.items[1]!.include = false })
    const [a, b] = r.document.items
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: 'done', [b!.id]: 'done' }))
    const [summary] = await listSessions(project)
    expect(summary).toMatchObject({ includedCount: 1, doneCount: 1, needsHumanCount: 0 })
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: { status: 'needs_human', note: '要素が無い' } }))
    const [again] = await listSessions(project)
    expect(again).toMatchObject({ includedCount: 1, doneCount: 0, needsHumanCount: 1 })
  })

  it('要約に送る指摘のIDを控え、版の古い・形の合わない要約は作り直す', () => {
    const r = record()
    r.document.items[0]!.include = false
    const stored = buildStoredSummary(r, [])
    expect(stored.includedIds).toEqual([r.document.items[1]!.id])
    expect(parseStoredSummary(stored)).toEqual(stored)
    expect(parseStoredSummary({ ...stored, version: 1 })).toBeNull()
    expect(parseStoredSummary({ ...stored, includedIds: [1] })).toBeNull()
  })
})

describe('Agent への指示', () => {
  it('feedback.md に各指摘の ID と、progress.json の書き方の節が入る', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'en', progressFile: '/p/.ferret/reviews/x/progress.json' })
    for (const it of doc.items) expect(md).toContain(`- ID: \`${it.id}\``)
    expect(md).toContain('## Progress')
    expect(md).toContain('`/p/.ferret/reviews/x/progress.json`')
    expect(md).toContain('`in_progress`')
    expect(md).toContain('`done`')
    // 判定モデルが無効なら、合格してから done にする文は付けない
    expect(md).not.toContain('passes the decision model')
  })

  it('判定モデルが有効なら、合格してから done にする（受け入れ確認の節と食い違わない）', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'en', decision: { threshold: 0.7, dir: '/p' } })
    expect(md).toContain('set a finding to `done` only after it passes the decision model')
    // 進み具合の節は受け入れ確認の節より前
    expect(md.indexOf('## Progress')).toBeLessThan(md.indexOf('## Acceptance check'))
    // パスを渡さなければ同じフォルダの progress.json と書く
    expect(md).toContain('progress.json in the same folder as this file')
  })

  it('日本語の feedback.md にも ID と節が入る', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'ja' })
    expect(md).toContain('## 進み具合')
    expect(md).toContain(`- ID: \`${doc.items[0]!.id}\``)
  })

  it('既定の指示文は progress.json の絶対パスと in_progress / done を伝える', () => {
    const target = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/p/.ferret/reviews/20261003-101500/feedback.md' }
    for (const locale of ['en', 'ja'] as const) {
      const text = renderAgentPrompt(target, null, locale)
      expect(text).toContain('"/p/.ferret/reviews/20261003-101500/progress.json"')
      expect(text).toContain('in_progress')
      expect(text).toContain('done')
    }
    expect(renderAgentPrompt({ relativeDir: '.ferret/reviews/20261003-101500' }, '{{progress}}')).toBe('.ferret/reviews/20261003-101500/progress.json')
  })

  it('既定の指示文は、未完了の指摘を並列で進めることと、前提が合わなければ needs_human で人間へ戻すことを伝える', () => {
    const target = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/p/.ferret/reviews/20261003-101500/feedback.md' }
    const en = renderAgentPrompt(target, null, 'en')
    expect(en).toContain('in parallel with sub-agents')
    expect(en).toContain('needs_human')
    const ja = renderAgentPrompt(target, null, 'ja')
    expect(ja).toContain('サブエージェントで並列')
    expect(ja).toContain('needs_human')
  })

  it('feedback.md に並列の進め方と、前提違いを needs_human で戻す手順が入る。判定モデルが有効なら確認待ちは受け入れ確認から外す', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'en' })
    expect(md).toContain('sub-agents or parallel tasks')
    expect(md).toContain('the recording no longer matches the current code or screen')
    expect(md).toContain('"status": "needs_human"')
    expect(md).not.toContain('leaves the acceptance check')
    const withDecision = renderFeedbackMarkdown(doc, { locale: 'en', decision: { threshold: 0.7, dir: '/p' } })
    expect(withDecision).toContain('A finding set to `needs_human` leaves the acceptance check until the reviewer answers')
  })
})

describe('確認への返答の送り直し', () => {
  const target = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/p/my app/.ferret/reviews/20261003-101500/feedback.md' }

  it('その指摘の番号・ID・返答と、feedback.md・progress.json のパスを1行で伝える', () => {
    const text = renderReplyPrompt(target, { n: 2, id: 'i2', reply: '新しい /pricing の作りに合わせて、\nボタンはヘッダーへ' }, 'en')
    expect(text).toContain('finding 2 (ID i2)')
    expect(text).toContain('"/p/my app/.ferret/reviews/20261003-101500/feedback.md"')
    expect(text).toContain('"/p/my app/.ferret/reviews/20261003-101500/progress.json"')
    expect(text).toContain('新しい /pricing の作りに合わせて、 ボタンはヘッダーへ')
    expect(text).toContain('Work on this finding only')
    expect(text).not.toMatch(/[\r\n]/)
    expect(fitsSingleWrite(sanitizePastePayload(text))).toBe(true)
    // 判定モデルが無効なら受け入れ確認の文は付けない
    expect(text).not.toContain('acceptance check')
  })

  it('判定モデルが有効なら、合格してから done にする文を足す。日本語でも同じ', () => {
    expect(renderReplyPrompt(target, { n: 1, id: 'i1', reply: 'はい' }, 'en', { threshold: 0.7 })).toContain('only after it passes the decision model')
    const ja = renderReplyPrompt(target, { n: 1, id: 'i1', reply: 'ヘッダーに置く' }, 'ja')
    expect(ja).toContain('指摘 1（ID i1）')
    expect(ja).toContain('「ヘッダーに置く」')
  })

  it('長い返答は上限で切り、1回の書き込みに収める', () => {
    const text = renderReplyPrompt(target, { n: 1, id: 'i1', reply: 'x'.repeat(REPLY_MAX * 3) }, 'en')
    expect(text).toContain('x'.repeat(REPLY_MAX))
    expect(text).not.toContain('x'.repeat(REPLY_MAX + 1))
    expect(fitsSingleWrite(sanitizePastePayload(text))).toBe(true)
  })
})
