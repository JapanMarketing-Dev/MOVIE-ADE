import { describe, expect, it } from 'vitest'
import { AttentionThrottle, INITIAL_TRACK, SETTLE_POLLS, advancePaneState, attentionEvents, type AttentionPane, type PaneTrack } from '../../src/renderer/terminal/agentAttention'
import { projectActivity } from '../../src/renderer/terminal/agentActivity'

/** 検知した状態を順に食べさせ、最後の表示状態を返す */
function run(detected: string[], seen = false, from: PaneTrack = INITIAL_TRACK): PaneTrack {
  return detected.reduce((track, state) => advancePaneState(track, state, seen), from)
}

const idle = Array<string>(SETTLE_POLLS).fill('idle')

describe('Agent の「終わった（まだ見ていない）」', () => {
  it('作業中のあと待機が続いたら、見ていなければ done、見ていれば idle', () => {
    expect(run(['working', ...idle]).state).toBe('done')
    expect(run(['working', ...idle], true).state).toBe('idle')
    expect(run(['blocked', ...idle]).state).toBe('done')
  })

  it('ツールの合間に一瞬だけ待機に見えても、作業中のまま', () => {
    expect(run(['working', 'idle']).state).toBe('working')
    expect(run(['working', 'idle', 'working', 'idle']).state).toBe('working')
  })

  it('done は見たら idle に戻る。見るまでは待機でもシェルに戻っても残る', () => {
    const done = run(['working', ...idle])
    expect(run(['idle', 'idle', 'unknown'], false, done).state).toBe('done')
    expect(advancePaneState(done, 'idle', true).state).toBe('idle')
    expect(advancePaneState(done, 'unknown', true).state).toBe('unknown')
  })

  it('作業中に Agent を閉じた（状態が分からない）ときは、終わったとはみなさず作業中をやめる', () => {
    expect(run(['working', 'unknown']).state).toBe('working')
    expect(run(['working', 'unknown', 'unknown']).state).toBe('unknown')
  })

  it('初めから待機中・素のシェルは done にならない', () => {
    expect(run(['idle', 'idle', 'idle']).state).toBe('idle')
    expect(run(['unknown', 'unknown']).state).toBe('unknown')
  })
})

const pane = (key: string, state: AttentionPane['state'], projectId: string | null = 'p1', seen = false): AttentionPane => ({ key, projectId, state, seen })

describe('通知する出来事', () => {
  it('確認待ちになったら1回だけ。見ているペイン・確認待ちのままは知らせない', () => {
    expect(attentionEvents([pane('a', 'working')], [pane('a', 'blocked')])).toEqual([{ kind: 'blocked', paneKey: 'a', projectId: 'p1' }])
    expect(attentionEvents([pane('a', 'blocked')], [pane('a', 'blocked')])).toEqual([])
    expect(attentionEvents([pane('a', 'working')], [pane('a', 'blocked', 'p1', true)])).toEqual([])
  })

  it('前回知らなかったペイン（開いた直後・読み込み直し）の確認待ちは知らせない', () => {
    expect(attentionEvents([], [pane('a', 'blocked')])).toEqual([])
  })

  it('プロジェクトの Agent が全部終わったときだけ done を知らせる', () => {
    // 片方がまだ作業中なら知らせない
    expect(attentionEvents([pane('a', 'working'), pane('b', 'working')], [pane('a', 'done'), pane('b', 'working')])).toEqual([])
    // 最後の1つが終わった
    expect(attentionEvents([pane('a', 'done'), pane('b', 'working')], [pane('a', 'done'), pane('b', 'done')])).toEqual([{ kind: 'done', paneKey: 'b', projectId: 'p1' }])
    // 別のプロジェクトは別に数える
    expect(attentionEvents([pane('a', 'working'), pane('c', 'working', 'p2')], [pane('a', 'done'), pane('c', 'working', 'p2')]))
      .toEqual([{ kind: 'done', paneKey: 'a', projectId: 'p1' }])
  })

  it('見ていて idle になった・done のまま続いている・確認待ちが残っているときは知らせない', () => {
    expect(attentionEvents([pane('a', 'working')], [pane('a', 'idle', 'p1', true)])).toEqual([])
    expect(attentionEvents([pane('a', 'done')], [pane('a', 'done')])).toEqual([])
    expect(attentionEvents([pane('a', 'working'), pane('b', 'blocked')], [pane('a', 'done'), pane('b', 'blocked')])).toEqual([])
  })
})

describe('通知の重複の抑止', () => {
  it('同じペインの確認待ち・同じプロジェクトの完了は、間が空くまで1回', () => {
    let now = 0
    const throttle = new AttentionThrottle(() => now, 15_000)
    const blocked = { kind: 'blocked', paneKey: 'a', projectId: 'p1' } as const
    expect(throttle.allow(blocked)).toBe(true)
    now = 5_000
    expect(throttle.allow(blocked)).toBe(false)
    expect(throttle.allow({ kind: 'blocked', paneKey: 'b', projectId: 'p1' })).toBe(true)
    expect(throttle.allow({ kind: 'done', paneKey: 'a', projectId: 'p1' })).toBe(true)
    expect(throttle.allow({ kind: 'done', paneKey: 'b', projectId: 'p1' })).toBe(false)
    now = 20_000
    expect(throttle.allow(blocked)).toBe(true)
  })
})

describe('サイドバーのプロジェクトの印', () => {
  it('確認待ち > 作業中 > 終わった の順で1つ。待機・不明・未登録のフォルダは出さない', () => {
    expect(projectActivity([
      { projectId: 'p1', state: 'done' },
      { projectId: 'p1', state: 'working' },
      { projectId: 'p2', state: 'done' },
      { projectId: 'p3', state: 'working' },
      { projectId: 'p3', state: 'blocked' },
      { projectId: 'p4', state: 'idle' },
      { projectId: 'p5', state: 'unknown' },
      { projectId: null, state: 'done' }
    ])).toEqual({ p1: 'working', p2: 'done', p3: 'blocked' })
  })
})
