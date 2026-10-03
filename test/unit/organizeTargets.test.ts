import { describe, expect, it } from 'vitest'
import { buildPayload, buildPrompt, MockRunner, organize, validateOrganizeOutput } from '../../src/main/pipeline/organize'
import { buildTargetIndex } from '../../src/main/pipeline/organize/targets'
import type { RawOrganizeOutput } from '../../src/main/pipeline/schema'
import type { Event, OrganizeInput, SessionMeta, TranscriptSegment } from '../../src/main/pipeline/types'

/**
 * 1本の録画の中で対象（URL・ファイル）を切り替えたとき、整理（LLM）が違う対象の指摘をまとめないこと。
 * 入力に対象の区切りを入れ、出力の target を検査し、欠け・食い違い・またがりは元の区切りに戻す。
 */

const meta: SessionMeta = {
  id: '20261003-130000', startedAt: '2026-10-03T13:00:00+09:00', durationMs: 30_000, twoSpeakers: false,
  urlPresets: [{ id: 'l', label: 'local', url: 'http://localhost:3000/' }]
}
// local → docs/a.md → local（行き来する）
const events: Event[] = [
  { t: 100, type: 'nav', url: 'http://localhost:3000/', title: 'トップ' },
  { t: 10_000, type: 'nav', url: 'ade-preview://project/docs/a.md', title: 'a.md' },
  { t: 12_000, type: 'text', id: 'x1-doc', x: 10, y: 10, body: '手順を番号付きにする' },
  { t: 20_000, type: 'nav', url: 'http://localhost:3000/#faq', title: 'トップ' }
]
const transcript: TranscriptSegment[] = [
  { t0: 2_000, t1: 4_000, speaker: 'self', text: '見出しが小さい', source: 'mic' },
  { t0: 11_000, t1: 13_000, speaker: 'self', text: '手順が分かりにくい', source: 'mic' },
  { t0: 21_000, t1: 23_000, speaker: 'self', text: '見出しをもっと大きく', source: 'mic' }
]
const input: OrganizeInput = { meta, transcript, events, frameTimes: [1_000, 11_500, 12_100, 21_500], draft: [] }

const item = (patch: Partial<RawOrganizeOutput['items'][number]>): RawOrganizeOutput['items'][number] => ({
  title: '見出し', request: '大きくする', status: 'decided', quote_ts: [2_000], frame_times: [1_000], annotation_ids: [], target: 'T1', ...patch
})
const run = (items: RawOrganizeOutput['items']) => validateOrganizeOutput({ items, dropped: [] }, input)
const codes = (r: ReturnType<typeof run>) => r.issues.map((i) => i.code)

describe('対象の区切り', () => {
  it('切り替えた対象に ID とラベルを付け、行き来しても同じ対象は同じ ID（アンカー違いも同じ）', () => {
    const index = buildTargetIndex(events, meta)
    expect(index.spans.map((s) => [s.id, s.label, s.kind, s.ranges])).toEqual([
      ['T1', 'local · localhost:3000', 'url', [[0, 10_000], [20_000, 30_000]]],
      ['T2', 'docs/a.md', 'file', [[10_000, 20_000]]]
    ])
    expect([0, 9_999, 10_000, 19_999, 20_000, 29_000].map((t) => index.at(t))).toEqual(['T1', 'T1', 'T2', 'T2', 'T1', 'T1'])
  })

  it('対象が1つなら区切らない（画面全体の録画・切り替えなし）', () => {
    expect(buildTargetIndex([events[0]!, events[3]!], meta).spans).toEqual([])
    expect(buildTargetIndex([], meta).at(5_000)).toBeNull()
  })

  it('入力の各発話・書き込み・遷移に対象の ID（tg）を付け、targets を並べる', () => {
    const payload = buildPayload(input)
    expect(payload.targets).toEqual([{ id: 'T1', label: 'local · localhost:3000', kind: 'url' }, { id: 'T2', label: 'docs/a.md', kind: 'file' }])
    expect(payload.transcript.map((s) => s.tg)).toEqual(['T1', 'T2', 'T1'])
    expect(payload.annotations.map((a) => a.tg)).toEqual(['T2'])
    expect(payload.screen.map((s) => s.tg)).toEqual(['T1', 'T2', 'T1'])
  })

  it('対象が1つなら targets も tg も入れない（プロンプトを変えない）', () => {
    const single = buildPayload({ ...input, events: [events[0]!] })
    expect(single.targets).toBeUndefined()
    expect(single.transcript.some((s) => 'tg' in s)).toBe(false)
  })

  it('違う対象の指摘をまとめないことを、プロンプトに明記する', () => {
    expect(buildPrompt(input, 'ja')).toContain('違う対象（tg が違う）の発話・書き込みを1件にまとめない')
    expect(buildPrompt(input, 'en')).toContain('Never merge utterances or marks from different targets')
  })
})

describe('出力の対象の検査', () => {
  it('対象が正しければそのまま通す', () => {
    const r = run([item({}), item({ title: '手順', quote_ts: [11_000], frame_times: [12_100], annotation_ids: ['x1-doc'], target: 'T2' })])
    expect(r.ok).toBe(true)
    expect(r.value!.items).toHaveLength(2)
    expect(codes(r).filter((c) => c.startsWith('target'))).toEqual([])
  })

  it('target が欠けていたら、根拠の時刻から対象を決める', () => {
    const { target: _omit, ...noTarget } = item({ quote_ts: [11_000], frame_times: [11_500] })
    const r = run([noTarget])
    expect(r.ok).toBe(true)
    expect(codes(r)).toContain('target-missing')
    expect(r.value!.items[0]!.frame_times).toEqual([11_500])
  })

  it('知らない target・根拠と食い違う target は、根拠の対象に直す', () => {
    expect(codes(run([item({ target: 'T9' })]))).toContain('target-unknown')
    const mismatch = run([item({ target: 'T2' })])
    expect(codes(mismatch)).toContain('target-mismatch')
    expect(mismatch.value!.items[0]!.quotes.map((q) => q.t)).toEqual([2_000])
  })

  it('違う対象の発話・書き込みを1件にまとめていたら、対象ごとの指摘に分ける（画像もその対象のもの）', () => {
    const r = run([item({ quote_ts: [2_000, 11_000, 21_000], annotation_ids: ['x1-doc'], frame_times: [1_000, 21_500] })])
    expect(r.ok).toBe(true)
    expect(codes(r)).toContain('target-mixed')
    expect(r.value!.items.map((i) => [i.quotes.map((q) => q.t), i.annotation_ids, i.frame_times])).toEqual([
      [[2_000, 21_000], [], [1_000, 21_500]],
      [[11_000], ['x1-doc'], [12_100]]
    ])
  })
})

describe('整理の経路（LLM はモック）', () => {
  it('LLM が対象をまたいでまとめても、対象ごとに分かれた指摘になる', async () => {
    const raw: RawOrganizeOutput = {
      items: [{ title: '全体に見づらい', request: '見やすくする', status: 'decided', quote_ts: [2_000, 11_000], frame_times: [1_000], annotation_ids: [], target: 'T1' }],
      dropped: []
    }
    const runner = new MockRunner({ kind: 'raw', raw: JSON.stringify(raw) })
    const result = await organize(input, { runner, cwd: '/tmp' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.output.items.map((i) => i.quotes.map((q) => q.t))).toEqual([[2_000], [11_000]])
    expect(result.output.items[1]!.frame_times).toEqual([11_500])
    // runner には対象の区切りを渡し、target を必須で求める
    expect(runner.calls[0]!.prompt).toContain('"targets":[{"id":"T1"')
    expect((runner.calls[0]!.schema as { properties: { items: { items: { required: string[] } } } }).properties.items.items.required).toContain('target')
  })
})
