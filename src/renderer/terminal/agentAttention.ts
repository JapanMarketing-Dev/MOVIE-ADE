/**
 * Agent の「終わった（まだ見ていない）」と、通知を出す出来事を決める（純粋な関数。TerminalPane が 1 秒ごとに呼ぶ）。
 *
 * 状態の検知そのものは main の detectState（working / blocked / idle / unknown）。ここではそれに
 * 「見ているか」を合わせて done を導く（04_benchmark 4.1-13 / herdr の seen フラグ、main/agent/state.ts の AgentStateTracker と同じ考え方）。
 *   - working|blocked → idle が SETTLE_POLLS 回続いたら終わったとみなす。見ていれば idle、見ていなければ done
 *   - done は、そのペインを見たら idle に戻る。Agent を閉じてシェルに戻っても（unknown）見るまでは done のまま
 */

export type PaneAgentState = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'

/** 終わったとみなすまでに idle が続く回数（1 秒ごと）。ツールの合間に一瞬だけ待機に見えるのを数えない */
export const SETTLE_POLLS = 2

export interface PaneTrack {
  state: PaneAgentState
  /** working|blocked のあと、idle か unknown が続いた回数 */
  idleStreak: number
}

export const INITIAL_TRACK: PaneTrack = { state: 'unknown', idleStreak: 0 }

/**
 * 検知した状態から、次の表示状態を決める。
 * @param detected main の terminal:agentState の state
 * @param seen そのペインが画面に出ていて、ウィンドウに焦点がある
 */
export function advancePaneState(prev: PaneTrack, detected: string, seen: boolean): PaneTrack {
  if (detected === 'working' || detected === 'blocked') return { state: detected, idleStreak: 0 }
  const finished: PaneAgentState = seen ? 'idle' : 'done'
  if (detected === 'idle') {
    if (prev.state === 'working' || prev.state === 'blocked') {
      const idleStreak = prev.idleStreak + 1
      return idleStreak >= SETTLE_POLLS ? { state: finished, idleStreak: 0 } : { state: prev.state, idleStreak }
    }
    if (prev.state === 'done') return { state: finished, idleStreak: 0 }
    return { state: 'idle', idleStreak: 0 }
  }
  // 状態が分からない（シェルに戻った・Agent を閉じた）。一瞬だけのものは数えず、続いたら作業中をやめる（終わったとはみなさない）。
  // 終わったものは見るまで残す
  if (prev.state === 'working' || prev.state === 'blocked') {
    const idleStreak = prev.idleStreak + 1
    return idleStreak >= SETTLE_POLLS ? { state: 'unknown', idleStreak: 0 } : { state: prev.state, idleStreak }
  }
  return { state: prev.state === 'done' && !seen ? 'done' : 'unknown', idleStreak: 0 }
}

/** ペイン1枚（通知を決めるための形） */
export interface AttentionPane {
  key: string
  projectId: string | null
  state: PaneAgentState
  /** 画面に出ていて、ウィンドウに焦点がある */
  seen: boolean
}

export type AttentionEvent =
  /** 確認待ち（許可・質問）になった */
  | { kind: 'blocked'; paneKey: string; projectId: string | null }
  /** そのプロジェクトの Agent がすべて終わった（作業中・確認待ちが無くなり、見ていない done がある） */
  | { kind: 'done'; paneKey: string; projectId: string | null }

const busy = (state: PaneAgentState | undefined): boolean => state === 'working' || state === 'blocked'

/** 前回と今回のペインから、知らせる出来事を出す。見ているペインのことは知らせない */
export function attentionEvents(prev: readonly AttentionPane[], next: readonly AttentionPane[]): AttentionEvent[] {
  const before = new Map(prev.map((pane) => [pane.key, pane]))
  const events: AttentionEvent[] = []
  for (const pane of next) {
    // 前回知らなかったペイン（開いた直後・画面の読み込み直し）は数えない。読み込み直すたびに鳴らさないため
    const was = before.get(pane.key)
    if (pane.state === 'blocked' && was !== undefined && was.state !== 'blocked' && !pane.seen) {
      events.push({ kind: 'blocked', paneKey: pane.key, projectId: pane.projectId })
    }
  }
  const projects = new Set(next.map((pane) => pane.projectId))
  for (const projectId of projects) {
    const now = next.filter((pane) => pane.projectId === projectId)
    if (now.some((pane) => busy(pane.state))) continue
    const finished = now.find((pane) => pane.state === 'done' && busy(before.get(pane.key)?.state))
    if (finished) events.push({ kind: 'done', paneKey: finished.key, projectId })
  }
  return events
}

/** 同じペインで続けて鳴らさない間隔(ms)。確認待ちと作業中を行き来しても1回にまとめる */
export const NOTIFY_COOLDOWN_MS = 15_000

/** 出来事ごとに、前に鳴らしてから間が空いているかを見る（重複の抑止） */
export class AttentionThrottle {
  private readonly last = new Map<string, number>()
  constructor(private readonly now: () => number = () => Date.now(), private readonly cooldownMs = NOTIFY_COOLDOWN_MS) {}

  allow(event: AttentionEvent): boolean {
    const id = `${event.kind}:${event.kind === 'done' ? event.projectId ?? '' : event.paneKey}`
    const at = this.now()
    const previous = this.last.get(id)
    if (previous !== undefined && at - previous < this.cooldownMs) return false
    this.last.set(id, at)
    return true
  }
}
