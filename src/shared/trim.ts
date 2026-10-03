/**
 * 録画の「何も起きていない時間」を削る（録画の頭・終わり・途中の長い空白）。
 *
 * 元の recording.webm は残し、削った版（recording.trimmed.webm）を別に作る（main/trimVideo.ts）。
 * 指摘の時刻・静止画は元の録画の時間のまま持ち、▷ で削った版を開くときだけ toTrimmedTime で読み替える。
 * renderer（再生位置）と main（区間の決定）の両方から使うので、Electron に依存しない純粋な処理だけを置く。
 */

/** 削る区間（元の録画の時間。ms。start 以上 end 未満） */
export interface TrimCut {
  start: number
  end: number
}

export interface IdleOptions {
  /** これより長く何も起きなければ削る（ms） */
  minIdleMs: number
  /** 削る区間の前後に残す余白（ms） */
  padMs: number
}

export const DEFAULT_IDLE_OPTIONS: IdleOptions = { minIdleMs: 3000, padMs: 500 }

/** 削った合計がこれ未満なら、削った版は作らない（作り直す手間に見合わない） */
export const MIN_TOTAL_CUT_MS = 1000

/**
 * 何かが起きていた区間（声・書き込み・クリック・スクロール・遷移・画面の変化）から、削る区間を決める。
 * 何も起きていない時間が minIdleMs 以上続くところを、前後に padMs の余白を残して削る。録画の頭と終わりも含める。
 * 何も起きていない録画（区間が1つも無い）は削らない（中身が無くなるため）
 */
export function findIdleCuts(activity: Array<[number, number]>, durationMs: number, options: Partial<IdleOptions> = {}): TrimCut[] {
  const { minIdleMs, padMs } = { ...DEFAULT_IDLE_OPTIONS, ...options }
  if (!Number.isFinite(durationMs) || durationMs <= 0) return []
  const spans = activity
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]): [number, number] => [Math.max(0, Math.min(a, b)), Math.min(durationMs, Math.max(a, b))])
    .filter(([a, b]) => a <= durationMs && b >= 0)
    .sort((x, y) => x[0] - y[0])
  if (!spans.length) return []

  // 重なる・接する区間をまとめる
  const merged: Array<[number, number]> = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }

  const cuts: TrimCut[] = []
  const gap = (from: number, to: number, head: boolean, tail: boolean) => {
    if (to - from < minIdleMs) return
    // 頭は録画の始まりから、終わりは録画の最後まで削る（録画の外側に余白は要らない。中身の側にだけ残す）
    const start = head ? 0 : from + padMs
    const end = tail ? durationMs : to - padMs
    if (end - start > 0) cuts.push({ start: Math.round(start), end: Math.round(end) })
  }
  gap(0, merged[0]![0], true, false)
  for (let i = 1; i < merged.length; i++) gap(merged[i - 1]![1], merged[i]![0], false, false)
  gap(merged.at(-1)![1], durationMs, false, true)
  return cuts
}

/** 削った合計（ms） */
export function totalCut(cuts: TrimCut[]): number {
  return cuts.reduce((sum, cut) => sum + Math.max(0, cut.end - cut.start), 0)
}

/** 削ったあとの長さ */
export function trimmedDuration(durationMs: number, cuts: TrimCut[]): number {
  return Math.max(0, durationMs - totalCut(cuts))
}

/** 残す区間（削る区間の補集合）。削った版を作るときに、この順に再生して録り直す */
export function keptSpans(durationMs: number, cuts: TrimCut[]): TrimCut[] {
  const out: TrimCut[] = []
  let at = 0
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    if (cut.start > at) out.push({ start: at, end: cut.start })
    at = Math.max(at, cut.end)
  }
  if (at < durationMs) out.push({ start: at, end: durationMs })
  return out
}

/**
 * 元の録画の時刻 → 削った版の時刻。削った区間の中の時刻は、その区間の直後（削った版で同じ位置）へ寄せる
 */
export function toTrimmedTime(cuts: TrimCut[] | undefined, t: number): number {
  if (!cuts?.length) return t
  let removed = 0
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    if (t >= cut.end) removed += cut.end - cut.start
    else if (t > cut.start) return Math.max(0, cut.start - removed)
    else break
  }
  return Math.max(0, t - removed)
}

/** 削った版の時刻 → 元の録画の時刻 */
export function toOriginalTime(cuts: TrimCut[] | undefined, t: number): number {
  if (!cuts?.length) return t
  let at = t
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    if (cut.start <= at) at += cut.end - cut.start
    else break
  }
  return at
}

/** session.json から読んだ削る区間を確かめる（壊れた値は捨てる）。並べ替えて重なりを除く */
export function sanitizeCuts(raw: unknown): TrimCut[] {
  if (!Array.isArray(raw)) return []
  const cuts = raw
    .filter((c): c is TrimCut => !!c && typeof c === 'object' && Number.isFinite((c as TrimCut).start) && Number.isFinite((c as TrimCut).end) && (c as TrimCut).end > (c as TrimCut).start && (c as TrimCut).start >= 0)
    .map((c) => ({ start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start)
  return cuts.filter((c, i) => i === 0 || c.start >= cuts[i - 1]!.end)
}
