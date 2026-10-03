import { describe, expect, it } from 'vitest'
import { organizeChunked, splitInput } from '../../src/main/pipeline/organize/chunked'
import { MockRunner } from '../../src/main/pipeline/organize/runners/mock'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import { material } from './fixtures'

const stage = buildDraftDocument(material)

describe('整理の時間帯分割', () => {
  it('下書きが少なければ分割しない', () => {
    expect(splitInput(stage.organizeInput, 100)).toHaveLength(1)
  })

  it('件数の目安を超えたら、間隔が大きいところで分割する', () => {
    const parts = splitInput(stage.organizeInput, 2)
    expect(parts.length).toBeGreaterThan(1);
    // 下書きが重複せず、全部どこかの区間に入る
    const ids = parts.flatMap((p) => p.draft.map((d) => d.id))
    expect(new Set(ids).size).toBe(stage.draft.items.length)
    expect(ids).toHaveLength(stage.draft.items.length)
  })

  it('各区間に、その時点の画面（直前のnav）を引き継ぐ', () => {
    const parts = splitInput(stage.organizeInput, 1)
    for (const p of parts) {
      if (p.draft[0]!.t < 13_000) continue
      expect(p.events.some((e) => e.type === 'nav')).toBe(true)
    }
  })

  it('区間ごとの文字起こしと静止画だけを渡す', () => {
    const parts = splitInput(stage.organizeInput, 1)
    const last = parts[parts.length - 1]!
    expect(last.transcript.every((s) => s.t1 >= last.draft[0]!.t - 2000)).toBe(true)
    expect(last.frameTimes.length).toBeLessThan(stage.organizeInput.frameTimes.length)
  });

  /** 区間ごとに、その区間の最初の発話を1件の指摘にして返す runner */
  function echoRunner(failFirst = false) {
    let call = 0
    return {
      id: 'echo',
      calls: 0,
      available: async () => true,
      run: async (req: { prompt: string }) => {
        call += 1
        if (failFirst && call === 1) throw new Error('この区間だけ失敗')
        // 入力（発話・下書き）と画面の証拠（書き込みなど）は別の囲みにある。両方を1つにまとめて読む
        const blocks = [...req.prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as object)
        const payload = Object.assign({}, ...blocks) as {
          transcript: Array<{ t: number }>
          annotations: Array<{ id: string }>
          frame_times: number[]
        };
        // 発話が無い区間（書き込みだけ）は書き込みを根拠にする
        const first = payload.transcript[0]
        return {
          raw: JSON.stringify({
            items: [
              {
                title: `区間 ${first?.t ?? payload.annotations[0]?.id}`,
                request: '直す',
                status: 'decided',
                quote_ts: first ? [first.t] : [],
                frame_times: [payload.frame_times[0]!],
                annotation_ids: first ? [] : payload.annotations.map((a) => a.id),
              },
            ],
            dropped: [],
          }),
          elapsedMs: 1,
          commandLine: 'echo',
        }
      },
    }
  }

  it('全区間が成功すれば指摘を時刻順に結合する', async () => {
    const r = await organizeChunked(stage.organizeInput, {
      runner: echoRunner(),
      cwd: '/tmp',
      itemsPerChunk: 1,
    })
    expect(r.ok).toBe(true)
    expect(r.failed).toBe(0)
    expect(r.parts).toHaveLength(stage.draft.items.length);
    // 時刻順に並ぶ
    const ts = r.output!.items.flatMap((i) => (i.quotes[0] ? [i.quotes[0].t] : []))
    expect([...ts]).toEqual([...ts].sort((a, b) => a - b))
  })

  it('同じ引用の指摘が区間をまたいで重複したら1件にまとめる', async () => {
    const runner = new MockRunner({
      kind: 'raw',
      raw: JSON.stringify({
        items: [
          {
            title: 'ボタンの色',
            request: '濃くする',
            status: 'decided',
            quote_ts: [18_000],
            frame_times: [19_750],
            annotation_ids: [],
          },
        ],
        dropped: [{ t: 18_000, reason: 'テスト' }],
      }),
    })
    const r = await organizeChunked(stage.organizeInput, { runner, cwd: '/tmp', itemsPerChunk: 1 })
    expect(r.ok).toBe(true);
    // 同じ引用時刻（18000）は、いくつの区間から返ってきても1件
    expect(r.output!.items).toHaveLength(1)
    expect(r.output!.dropped).toHaveLength(1)
  })

  it('一部の区間が失敗しても、成功した区間の指摘を使う', async () => {
    const r = await organizeChunked(stage.organizeInput, {
      runner: echoRunner(true),
      cwd: '/tmp',
      itemsPerChunk: 1,
    })
    expect(r.ok).toBe(true)
    expect(r.failed).toBe(1)
    expect(r.output!.items).toHaveLength(stage.draft.items.length - 1)
  })

  it('全区間が失敗したら ok:false（下書きへフォールバック）', async () => {
    const runner = new MockRunner({ kind: 'raw', raw: '{"items":[],"dropped":[]}' })
    const r = await organizeChunked(stage.organizeInput, { runner, cwd: '/tmp', itemsPerChunk: 1 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})
