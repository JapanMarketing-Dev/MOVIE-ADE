import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyProgress,
  countProgress,
  nextProgress,
  applyVerdict,
  lastVerdict,
  normalizeProgress,
  parseProgress,
  pendingIds,
  queuedIds,
  recentComments,
  progressChangedIds,
  PROGRESS_NOTE_MAX,
  sentPatch,
  serializeProgress
} from '@shared/findingProgress'
import { NG_TOTAL_MAX, REPLY_MAX, renderAgentPrompt, renderNgPrompt } from '@shared/agentPrompt'
import { fitsSingleWrite, sanitizePastePayload } from '../../src/main/agent/sanitize'
import { appendEvents, createSession, listSessions, readProgress, saveSession, updateProgress, updateProgressWith, type SessionRecord } from '../../src/main/sessions/index'
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
      .toEqual({ a: { status: 'human_review' }, b: { status: 'in_progress' } })
  })

  it('文字列だけの古い形と、ひとことつきの新しい形のどちらも読む。古い needs_human は確認待ち（human_review）として読み、note は残す', () => {
    expect(parseProgress({
      i1: 'done',
      i2: { status: 'needs_human', note: '  録画の Sign up ボタンは今のコードに無い  ' },
      i3: { status: 'Needs Human' },
      i4: { status: 'in_progress', reply: 'ヘッダーに置く', note: 42 },
      i5: { status: 'bogus', note: 'x' },
      i6: 'needs_human'
    })).toEqual({
      i1: { status: 'human_review' },
      i2: { status: 'human_review', note: '録画の Sign up ボタンは今のコードに無い' },
      i3: { status: 'human_review' },
      i4: { status: 'in_progress' },
      i6: { status: 'human_review' }
    })
    expect(normalizeProgress('needs-human')).toBe('human_review')
  })

  it('ひとことは長すぎれば切る', () => {
    const long = 'あ'.repeat(PROGRESS_NOTE_MAX + 50)
    expect(parseProgress({ a: { status: 'human_review', note: long } }).a?.note).toHaveLength(PROGRESS_NOTE_MAX)
  })

  it('knownIds を渡すと、そのレビューに無い指摘のIDを落とす', () => {
    expect(parseProgress({ a: 'done', ghost: 'done' }, ['a', 'b'])).toEqual({ a: { status: 'human_review' } })
  })

  it('変更を重ねる。todo は消し、読めない値は無視し、状態を変えると古い理由は消える', () => {
    expect(applyProgress({ a: { status: 'done' }, b: { status: 'in_progress' }, d: { status: 'human_review', note: '古い' } },
      { a: 'todo', c: 'done', b: 'nope' as never, d: { status: 'in_progress' } }))
      .toEqual({ b: { status: 'in_progress' }, c: { status: 'done' }, d: { status: 'in_progress' } })
    // 古い指示の Agent が needs_human を書いても、確認待ちとして重ねる
    expect(applyProgress({}, { a: { status: 'needs_human' as never, note: '仮定した' } })).toEqual({ a: { status: 'human_review', note: '仮定した' } })
    expect(applyProgress({ a: { status: 'done' } }, { a: { status: 'todo' } })).toEqual({})
  })

  it('ファイルへは、ひとことなどが無ければ文字列だけで書く（Agent が読み書きしやすい形）', () => {
    expect(serializeProgress({ a: { status: 'done' }, b: { status: 'human_review', note: 'n' } })).toEqual({ a: 'done', b: { status: 'human_review', note: 'n' } })
  })

  it('ボタンは 未対応 → 対応中 → 完了 → 未対応。確認待ちは対応中へ', () => {
    expect(nextProgress('todo')).toBe('in_progress')
    expect(nextProgress('in_progress')).toBe('done')
    expect(nextProgress('done')).toBe('todo')
    expect(nextProgress('human_review')).toBe('in_progress')
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
    expect(countProgress(items, { a: { status: 'done' }, b: { status: 'in_progress' }, c: { status: 'human_review' }, d: { status: 'human_review', note: 'x' } }))
      .toEqual({ done: 1, inProgress: 1, humanReview: 1, queued: 0, total: 3 })
    expect(countProgress(items, undefined)).toEqual({ done: 0, inProgress: 0, humanReview: 0, queued: 0, total: 3 })
    expect(countProgress(items, { a: { status: 'human_review', after: 'after/a.png' }, b: { status: 'in_progress', queued: true } }))
      .toEqual({ done: 0, inProgress: 1, humanReview: 1, queued: 1, total: 3 })
    // 古い needs_human は確認待ちとして数える（Agent からの質問の件数は無い）
    expect(countProgress(items, parseProgress({ a: { status: 'needs_human', note: '古い' } }))).toEqual({ done: 0, inProgress: 0, humanReview: 1, queued: 0, total: 3 })
  })

  it('送信したら、送った指摘の未対応だけを対応中にする（完了・確認待ちは変えない・外した指摘は触らない）', () => {
    expect(sentPatch(items, { a: { status: 'done' }, d: { status: 'human_review' } })).toEqual({ b: 'in_progress' })
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
    // 古い progress.json の needs_human は、書き直すときに確認待ち（human_review）にそろう。note は Agent のひとこととして残す
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: { status: 'needs_human', note: '録画が古い', reply: '前の返答' }, other: 'done' }))
    expect(await updateProgress(p, { [b!.id]: 'in_progress' })).toEqual({ [a!.id]: { status: 'human_review', note: '録画が古い' }, other: { status: 'human_review' }, [b!.id]: { status: 'in_progress' } })
    expect(JSON.parse(await readFile(p.progressJson, 'utf8'))).toEqual({ [a!.id]: { status: 'human_review', note: '録画が古い' }, other: 'human_review', [b!.id]: 'in_progress' })
  })

  it('一覧は 完了数/対象数 を返す。Send to Agent から外した指摘は数えない', async () => {
    const { p, r } = await saved((rec) => { rec.document.items[1]!.include = false })
    const [a, b] = r.document.items
    // 人の OK がある done だけを完了と数える（Agent が書いた done は確認待ち）
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: { status: 'done', history: [{ at: '2026-10-03T10:00:00.000Z', verdict: 'ok' }] }, [b!.id]: 'done' }))
    const [summary] = await listSessions(project)
    expect(summary).toMatchObject({ includedCount: 1, doneCount: 1, humanReviewCount: 0 })
    expect(summary).not.toHaveProperty('needsHumanCount')
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: 'done' }))
    const [agentDone] = await listSessions(project)
    expect(agentDone).toMatchObject({ includedCount: 1, doneCount: 0, humanReviewCount: 1 })
    // 古い needs_human は確認待ちとして数える
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: { status: 'needs_human', note: '要素が無い' } }))
    const [again] = await listSessions(project)
    expect(again).toMatchObject({ includedCount: 1, doneCount: 0, humanReviewCount: 1 })
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

  it('判定モデルが有効なら、それで直しを詰めてから human_review にする（人への質問にはしない。受け入れ確認の節と食い違わない）', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'en', decision: { threshold: 0.7, dir: '/p' } })
    expect(md).toContain('It is your own check for getting the fix right, not a question for the reviewer')
    expect(md).toContain('then set `human_review` with `after` and `score`')
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

  it('既定の指示文は progress.json の絶対パスと、直す → AFTER → human_review の単位を並列で進めること、done は人だけと伝える', () => {
    const target = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/p/.ferret/reviews/20261003-101500/feedback.md' }
    for (const locale of ['en', 'ja'] as const) {
      const text = renderAgentPrompt(target, null, locale)
      expect(text).toContain('"/p/.ferret/reviews/20261003-101500/progress.json"')
      expect(text).toContain('human_review')
      expect(text).toContain('AFTER')
    }
    expect(renderAgentPrompt(target, null, 'en')).toContain('only the reviewer sets done')
    expect(renderAgentPrompt(target, null, 'ja')).toContain('done にするのはレビューした人だけ')
    expect(renderAgentPrompt({ relativeDir: '.ferret/reviews/20261003-101500' }, '{{progress}}')).toBe('.ferret/reviews/20261003-101500/progress.json')
  })

  it('既定の指示文は、未完了の指摘を並列で進め、前提が合わなくても人に質問せず仮定を note に書いて human_review にすることを伝える', () => {
    const target = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/p/.ferret/reviews/20261003-101500/feedback.md' }
    for (const decision of [null, { threshold: 0.7 }]) {
      const en = renderAgentPrompt(target, null, 'en', decision)
      expect(en).toContain('in parallel with sub-agents')
      expect(en).toContain('Never stop to ask the reviewer questions')
      expect(en).toContain('what you assumed in a one-line note')
      expect(en).not.toContain('needs_human')
      const ja = renderAgentPrompt(target, null, 'ja', decision)
      expect(ja).toContain('サブエージェントで並列')
      expect(ja).toContain('レビューした人に質問して止まらないでください')
      expect(ja).not.toContain('needs_human')
    }
  })

  it('feedback.md に並列の進め方と、前提違いでも質問せずに直して仮定を note に書く手順が入る。書く状態は in_progress と human_review だけ', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'en' })
    expect(md).toContain('sub-agents or parallel tasks')
    expect(md).toContain('the recording no longer matches the current code or screen')
    expect(md).toContain('The only statuses you write are `in_progress` and `human_review`')
    expect(md).toContain('Never stop to ask the reviewer anything')
    expect(md).toContain('one line saying what you assumed')
  })
})

describe('Agent は人に質問しない（判定モデルは Agent 自身の確認。人は BEFORE / AFTER で OK / NG だけ）', () => {
  /** 人へ質問させる・人の答えを待たせる言い回し（前の needs_human の手順にあったもの） */
  const ASKING = [
    /needs_human/,
    /needs you/i,
    /what you need decided/i,
    /reviewer answers/i,
    /waiting for the reviewer's answer/i,
    /until the reviewer answers/i,
    /report it as stuck/i,
    /please judge/i,
    /stop and report/i,
    /判断してほしい|決めてほしい|返答待ち|答えるまで|行き詰まりとして報告|止めて、Cloudflare/
  ]
  const PLEASE_JUDGE_OK = /never write requests such as "please judge"|「判断してください」のような頼みごとや質問を書かないこと/

  for (const locale of ['en', 'ja'] as const) {
    for (const decision of [undefined, { threshold: 0.7, dir: '/p' }]) {
      it(`${locale}・判定モデル${decision ? 'あり' : 'なし'}の feedback.md は needs_human を含まず、人へ質問させない`, () => {
        const doc = assembleFromOrganized(material, organized)
        // デザイン・文書の指摘（直せないものの扱い）と、「やり直さない」節も出す形で確かめる
        const [a, b] = doc.items
        const md = renderFeedbackMarkdown(doc, { locale, ...(decision ? { decision } : {}), focusIds: [b!.id], progress: { [a!.id]: { status: 'human_review' } } })
        const full = renderFeedbackMarkdown(doc, { locale, ...(decision ? { decision } : {}) })
        for (const text of [md, full]) {
          const checked = text.replace(PLEASE_JUDGE_OK, '')
          for (const pattern of ASKING) expect(checked).not.toMatch(pattern)
          expect(text).toMatch(locale === 'en' ? /Never stop to ask the reviewer anything/ : /レビューした人に質問して止まらないこと/)
        }
        if (decision) {
          // 判定モデルは自分の確認。上限まで合格しなくても human_review にして、人が BEFORE / AFTER で決める
          expect(full).toMatch(locale === 'en' ? /your own check/ : /あなた自身の確認/)
          expect(full).toMatch(locale === 'en' ? /3 rounds in a row with no change in its scores, or for 5 rounds in all/ : /3回続けてスコアも変わらずに失敗しているか、全部で5回失敗した/)
          expect(full).toMatch(locale === 'en' ? /still set it to `human_review`/ : /そのときも `human_review` にする/)
          expect(full).toMatch(locale === 'en' ? /go on without the decision model/ : /判定モデルなしで続ける/)
        }
      })
    }
  }

  it('Agent への指示文（既定・NG の送り直し）も needs_human を含まない', () => {
    const target = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/p/.ferret/reviews/20261003-101500/feedback.md' }
    for (const locale of ['en', 'ja'] as const) {
      for (const decision of [null, { threshold: 0.7 }]) {
        expect(renderAgentPrompt(target, null, locale, decision)).not.toContain('needs_human')
        expect(renderNgPrompt(target, [{ n: 1, id: 'i1', comment: 'まだ違う' }], locale, decision)).not.toContain('needs_human')
      }
    }
    expect(renderNgPrompt(target, [{ n: 1, id: 'i1', comment: 'x' }], 'en', { threshold: 0.7 })).toContain('once the round limit is reached')
  })
})

describe('Send to Agent で送る対象（未対応の指摘だけ）', () => {
  const items = [
    { id: 'i1', include: true },
    { id: 'i2', include: true },
    { id: 'i3', include: true },
    { id: 'i4', include: true },
    { id: 'i5', include: false },
    { id: 't2-1', include: true }
  ]

  it('todo で送る対象のものだけ。done・in_progress・human_review と include=false は送らない。追加で録った指摘も未対応なら送る', () => {
    expect(pendingIds(items, { i1: { status: 'done' }, i2: { status: 'in_progress' }, i3: { status: 'human_review', note: 'x' } })).toEqual(['i4', 't2-1'])
    expect(pendingIds(items, undefined)).toEqual(['i1', 'i2', 'i3', 'i4', 't2-1'])
  })

  it('全部着手済みなら0件', () => {
    expect(pendingIds(items, { i1: { status: 'done' }, i2: { status: 'done' }, i3: { status: 'in_progress' }, i4: { status: 'human_review' }, 't2-1': { status: 'done' } })).toEqual([])
    expect(sentPatch(items, { i1: { status: 'done' }, i2: { status: 'done' }, i3: { status: 'done' }, i4: { status: 'done' }, 't2-1': { status: 'done' } })).toEqual({})
  })

  it('feedback.md は今回送る指摘だけを詳しく書き、残りは「やり直さない」節に状態つきで載せる。番号は全件を通して振る', () => {
    const doc = assembleFromOrganized(material, organized)
    const [a, b] = doc.items
    const md = renderFeedbackMarkdown(doc, { locale: 'en', focusIds: [b!.id], progress: { [a!.id]: { status: 'done' } } })
    expect(md).toContain('# ')
    expect(md).toContain(`- ID: \`${b!.id}\``)
    expect(md).not.toContain(`- ID: \`${a!.id}\``)
    expect(md).toContain('## Other findings (not in this request)')
    expect(md).toContain(`- 1. \`${a!.id}\` ${a!.title} — Done`)
    expect(md).toMatch(/## 2\. \[/)
    expect(md).not.toMatch(/## 1\. \[/)
    // 判定モデルが無効なら受け入れ確認の対象の文は付けない
    expect(md).not.toContain('acceptance check covers only')
  })

  it('判定モデルが有効なら、受け入れ確認（全件合格のループ）は今回送る指摘だけが対象と書く', () => {
    const doc = assembleFromOrganized(material, organized)
    const [a, b] = doc.items
    const md = renderFeedbackMarkdown(doc, { locale: 'en', focusIds: [b!.id], progress: { [a!.id]: { status: 'in_progress' } }, decision: { threshold: 0.7, dir: '/p' } })
    expect(md).toContain('The acceptance check covers only the findings in this request')
    expect(md).toContain('In progress')
    // BEFORE の画像（判定に使う）は今回の指摘の分だけ
    expect(md.match(/- BEFORE image \(for the acceptance check\)/g)?.length).toBe(1)
    const ja = renderFeedbackMarkdown(doc, { locale: 'ja', focusIds: [b!.id], progress: { [a!.id]: { status: 'human_review' } } })
    expect(ja).toContain('## ほかの指摘（今回の依頼に含まない）')
    expect(ja).toContain('レビューした人の確認待ち')
  })

  it('focusIds を渡さなければ今までどおり全件を詳しく書き、「やり直さない」節は出さない', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { locale: 'en' })
    for (const it of doc.items) expect(md).toContain(`- ID: \`${it.id}\``)
    expect(md).not.toContain('Other findings (not in this request)')
  })
})

describe('送る直前の feedback.md（prepareSendFeedback と同じ組み立て）', () => {
  let project: string
  beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'ade-pending-')) })
  afterEach(async () => { await rm(project, { recursive: true, force: true }) })

  it('progress.json の状態から送る対象を選び、その ID だけを詳しく書く', async () => {
    const p = await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
    await appendEvents(p, events)
    const r = record()
    await saveSession(p, r)
    const [a, b] = r.document.items
    await writeFile(p.progressJson, JSON.stringify({ [a!.id]: { status: 'done', history: [{ at: '2026-10-03T10:00:00.000Z', verdict: 'ok' }] } }))
    const progress = await readProgress(p)
    const ids = pendingIds(r.document.items, progress)
    expect(ids).toEqual([b!.id])
    const md = renderFeedbackMarkdown(r.document, { locale: 'en', focusIds: ids, progress, progressFile: p.progressJson })
    expect(md).toContain(`- ID: \`${b!.id}\``)
    expect(md).toContain(`\`${a!.id}\` ${a!.title} — Done`)
  })
})

describe('人の確認（human_review → OK / NG / Comment）', () => {
  const at = '2026-10-03T10:00:00.000Z'

  it('Agent が done を書いても、人の OK が無ければ human_review として読む。OK の記録があれば done', () => {
    expect(parseProgress({ a: 'done', b: { status: 'done', after: 'after/b.png' } })).toEqual({ a: { status: 'human_review' }, b: { status: 'human_review', after: 'after/b.png' } })
    expect(parseProgress({ a: { status: 'done', history: [{ at, verdict: 'ok' }] } }).a?.status).toBe('done')
    // 最後の判断が NG なら、done と書かれても確認待ち
    expect(parseProgress({ a: { status: 'done', history: [{ at, verdict: 'ok' }, { at, verdict: 'ng', text: '色が違う' }] } }).a?.status).toBe('human_review')
    // Comment は判断ではないので、OK のあとにあっても done のまま
    expect(parseProgress({ a: { status: 'done', history: [{ at, verdict: 'ok' }, { at, verdict: 'comment', text: 'メモ' }] } }).a?.status).toBe('done')
  })

  it('after と score は検証して読み、壊れた値・フォルダの外を指すパスは捨てる', () => {
    const m = parseProgress({
      a: { status: 'human_review', after: 'after/a.png', score: { noul: 0.92, choice: 'done', confidence: 0.66, rounds: 2 } },
      b: { status: 'human_review', after: '../secret.png', score: { noul: 7 } },
      c: { status: 'human_review', history: [{ at: 'x', verdict: 'ok' }, { at, verdict: 'maybe' }, 'bad'] }
    })
    expect(m.a).toEqual({ status: 'human_review', after: 'after/a.png', score: { noul: 0.92, choice: 'done', confidence: 0.66, rounds: 2 } })
    expect(m.b).toEqual({ status: 'human_review' })
    expect(m.c).toEqual({ status: 'human_review' })
  })

  it('OK で done、NG で in_progress（送り直し待ち）、Comment は状態を変えずに記録だけ残す', () => {
    const review = { status: 'human_review' as const, after: 'after/a.png', note: 'ボタンを青に', score: { noul: 0.9 } }
    const ok = applyVerdict(review, 'ok', undefined, at)
    expect(ok).toEqual({ status: 'done', after: 'after/a.png', score: { noul: 0.9 }, history: [{ at, verdict: 'ok' }] })
    expect(parseProgress({ a: ok }).a?.status).toBe('done')
    const ng = applyVerdict(review, 'ng', '  まだ灰色に見える  ', at)
    // NG のときも前の AFTER・スコアは残す（Agent が撮り直したら上書き）
    expect(ng).toEqual({ status: 'in_progress', after: 'after/a.png', score: { noul: 0.9 }, history: [{ at, verdict: 'ng', text: 'まだ灰色に見える' }], queued: true })
    expect(lastVerdict(ng)).toBe('ng')
    const comment = applyVerdict(review, 'comment', 'ホバーの色も見て', at)
    expect(comment).toEqual({ ...review, history: [{ at, verdict: 'comment', text: 'ホバーの色も見て' }] })
    // 未対応の指摘にもコメントを残せる（次に送るとき Agent に渡る）
    expect(applyVerdict(undefined, 'comment', '先にこれを', at)).toEqual({ status: 'todo', history: [{ at, verdict: 'comment', text: '先にこれを' }] })
  })

  it('コメントだけの未対応の指摘は todo のまま。送る対象にも入り、送ったら記録を残して対応中にする', () => {
    const map = parseProgress({ a: { status: 'todo', history: [{ at, verdict: 'comment', text: '先にこれを' }] } })
    expect(map.a?.status).toBe('todo')
    const items = [{ id: 'a', include: true }]
    expect(pendingIds(items, map)).toEqual(['a'])
    expect(applyProgress(map, sentPatch(items, map)).a).toEqual({ status: 'in_progress', history: [{ at, verdict: 'comment', text: '先にこれを' }] })
  })

  it('状態を変えても記録・AFTER・スコアは残り、todo に戻すと AFTER・スコアは消える', () => {
    const cur = { a: { status: 'in_progress' as const, after: 'after/a.png', score: { noul: 0.5 }, history: [{ at, verdict: 'ng' as const, text: 'x' }], queued: true as const } }
    expect(applyProgress(cur, { a: 'in_progress' }).a).toEqual({ status: 'in_progress', after: 'after/a.png', score: { noul: 0.5 }, history: [{ at, verdict: 'ng', text: 'x' }] })
    expect(applyProgress(cur, { a: 'todo' }).a).toEqual({ status: 'todo', history: [{ at, verdict: 'ng', text: 'x' }] })
    expect(applyProgress({ b: { status: 'done' } }, { b: 'todo' })).toEqual({})
  })

  it('Send to Agent の対象から human_review・NG の送り直し待ちを除く。送り直し待ちは別に選ぶ', () => {
    const items = [{ id: 'a', include: true }, { id: 'b', include: true }, { id: 'c', include: true }, { id: 'd', include: false }]
    const map = parseProgress({ a: { status: 'human_review', after: 'after/a.png' }, b: { status: 'in_progress', queued: true, history: [{ at, verdict: 'ng', text: '違う' }] }, d: { status: 'in_progress', queued: true } })
    expect(pendingIds(items, map)).toEqual(['c'])
    expect(queuedIds(items, map)).toEqual(['b'])
  })

  it('直近のコメント（NG・Comment）を新しい順に返す。OK は含めない', () => {
    const entry = parseProgress({ a: { status: 'in_progress', history: [{ at, verdict: 'comment', text: '1' }, { at, verdict: 'ok' }, { at, verdict: 'ng', text: '2' }, { at, verdict: 'comment', text: '3' }] } }).a
    expect(recentComments(entry).map((e) => e.text)).toEqual(['3', '2', '1'])
  })

  it('feedback.md の各指摘に人のコメントが載る', () => {
    const doc = assembleFromOrganized(material, organized)
    const [a] = doc.items
    const md = renderFeedbackMarkdown(doc, { locale: 'en', progress: { [a!.id]: { status: 'in_progress', history: [{ at, verdict: 'ng', text: 'Still grey on hover' }] } } })
    expect(md).toContain('Reviewer\'s notes (newest first): "Still grey on hover"')
    expect(md).toContain('set it to `human_review` again')
    // done にするのは人だけ、と書く
    expect(md).toContain('Only the reviewer sets `done`')
  })

  it('判断の記録はファイルに残り、読み直しても同じ', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ade-verdict-'))
    try {
      const p = await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
      await writeFile(p.progressJson, JSON.stringify({ i1: { status: 'human_review', after: 'after/i1.png' } }))
      await updateProgressWith(p, (cur) => ({ ...cur, i1: applyVerdict(cur.i1, 'ng', 'ボタンが小さい', at) }))
      const saved = JSON.parse(await readFile(p.progressJson, 'utf8'))
      expect(saved.i1).toEqual({ status: 'in_progress', after: 'after/i1.png', history: [{ at, verdict: 'ng', text: 'ボタンが小さい' }], queued: true })
      await updateProgressWith(p, (cur) => ({ ...cur, i1: applyVerdict(cur.i1, 'ok', undefined, at) }))
      expect((await readProgress(p)).i1?.status).toBe('done')
    } finally { await rm(project, { recursive: true, force: true }) }
  })
})

describe('NG をまとめて送る文面', () => {
  const target = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/p/.ferret/reviews/20261003-101500/feedback.md' }

  it('NG の指摘の番号・ID・コメントだけを1行で載せ、直して AFTER を撮り直し human_review に戻させる', () => {
    const text = renderNgPrompt(target, [{ n: 2, id: 'i2', comment: 'まだ灰色\nホバーも' }, { n: 5, id: 't2-1', comment: '余白が足りない' }], 'en')
    expect(text).toContain('sent back 2 finding(s)')
    expect(text).toContain('#2 (ID i2): "まだ灰色 ホバーも"; #5 (ID t2-1): "余白が足りない"')
    expect(text).toContain('"/p/.ferret/reviews/20261003-101500/progress.json"')
    expect(text).toContain('human_review')
    expect(text).toContain('in parallel with sub-agents')
    expect(text).not.toContain('i1')
    expect(text).not.toMatch(/[\r\n]/)
    expect(fitsSingleWrite(sanitizePastePayload(text))).toBe(true)
    expect(text).not.toContain('acceptance check')
  })

  it('判定モデルが有効なら、合格するか回数の上限で human_review にする（done にしない）を足す。日本語でも同じ形', () => {
    expect(renderNgPrompt(target, [{ n: 1, id: 'i1', comment: 'x' }], 'en', { threshold: 0.7 })).toContain('set them to human_review once they pass or once the round limit is reached. Never set done.')
    const ja = renderNgPrompt(target, [{ n: 1, id: 'i1', comment: '色が違う' }, { n: 3, id: 'i3', comment: '小さい' }], 'ja')
    expect(ja).toContain('#1（ID i1）「色が違う」、#3（ID i3）「小さい」')
    expect(ja).toContain('human_review に戻して')
  })

  it('件数が多くても送信の上限に収まるよう、1件の長さを割り当てる', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, id: `i${i + 1}`, comment: 'x'.repeat(REPLY_MAX) }))
    const text = renderNgPrompt(target, many, 'en')
    expect(text.length).toBeLessThan(NG_TOTAL_MAX + 3000)
    expect(text).toContain('ID i40')
  })
})

describe('progress.json をリンクにされても、フォルダの外へ読み書きしない', () => {
  it.skipIf(process.platform === 'win32')('リンクの progress.json は読まず、書くときはリンク先ではなくリンクそのものを置き換える', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ade-progress-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'ade-progress-outside-'))
    try {
      const p = await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
      const target = join(outside, 'victim.json')
      await writeFile(target, JSON.stringify({ i1: 'in_progress' }))
      await symlink(target, p.progressJson)
      expect(await readProgress(p)).toEqual({})
      await updateProgress(p, { i2: 'in_progress' })
      expect(await readFile(target, 'utf8')).toBe(JSON.stringify({ i1: 'in_progress' }))
      expect(JSON.parse(await readFile(p.progressJson, 'utf8'))).toEqual({ i2: 'in_progress' })
    } finally {
      await rm(project, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

