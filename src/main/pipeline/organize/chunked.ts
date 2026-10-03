/**
 * ③ 整理を時間帯で分割して並列に実行する。
 *
 * なぜ必要か: LLMの所要時間はほぼ出力トークン数に比例する（実測）。録画が長くなるほど
 * 1回の呼び出しが線形に伸び、NF-3 の「5分の録画で60秒以内」を超える。
 * 指摘は長い無音をまたがないので、無音の大きい切れ目で区切って並列に投げれば、
 * 所要時間は「最も重い区間ぶん」に収まる。
 *
 * 同じ仕組みで、録画中に区間が確定した時点から先に整理を始めることもできる
 * （文字起こしの逐次処理と同じ考え方）。
 */
import type { OrganizeInput, OrganizeOutput } from '../types'
import { organize } from './index'
import type { OrganizeOptions, OrganizeResult } from './index'

export interface ChunkedOptions extends OrganizeOptions {
  /** 1区間あたりの下書き件数の目安。これを超えたら区間を増やす */
  itemsPerChunk?: number;
  /** 同時に走らせる子プロセスの数の上限 */
  concurrency?: number
}

export interface ChunkedResult {
  ok: boolean
  output?: OrganizeOutput;
  /** 区間ごとの結果（計測・調査用） */
  parts: OrganizeResult[];
  /** 全体の所要時間（並列なので最も遅い区間に近い） */
  elapsedMs: number;
  /** 失敗した区間の数 */
  failed: number
  reason?: string
}

/** 時間帯で入力を切る。境界は「下書きの切れ目のうち間隔が最も大きいところ」 */
export function splitInput(input: OrganizeInput, itemsPerChunk: number): OrganizeInput[] {
  const draft = [...input.draft].sort((a, b) => a.t - b.t)
  if (draft.length <= itemsPerChunk) return [input]

  const chunkCount = Math.ceil(draft.length / itemsPerChunk);
  // 下書きの隙間を大きい順に並べ、上位 chunkCount-1 本を境界にする
  const gaps = draft
    .slice(1)
    .map((d, i) => ({ index: i + 1, gap: d.t - draft[i]!.tEnd }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, chunkCount - 1)
    .map((g) => g.index)
    .sort((a, b) => a - b)

  const groups: typeof draft[] = []
  let start = 0
  for (const b of [...gaps, draft.length]) {
    groups.push(draft.slice(start, b))
    start = b
  }

  return groups
    .filter((g) => g.length > 0)
    .map((g) => {
      const t0 = g[0]!.t
      const t1 = g[g.length - 1]!.tEnd
      return sliceInput(input, t0, t1, g)
    })
}

function sliceInput(
  input: OrganizeInput,
  t0: number,
  t1: number,
  draft: OrganizeInput['draft'],
): OrganizeInput {
  const pad = 2000
  const lo = t0 - pad
  const hi = t1 + pad

  const transcript = input.transcript.filter((s) => s.t1 >= lo && s.t0 <= hi)
  const inWindow = input.events.filter((e) => e.t >= lo && e.t <= hi);
  // 区間の開始時点の画面が分かるように、直前の nav / viewport を1つずつ足す
  const lastNav = [...input.events].filter((e) => e.type === 'nav' && e.t < lo).pop()
  const lastViewport = [...input.events].filter((e) => e.type === 'viewport' && e.t < lo).pop()
  const events = [...(lastNav ? [lastNav] : []), ...(lastViewport ? [lastViewport] : []), ...inWindow].sort(
    (a, b) => a.t - b.t,
  )

  return {
    meta: input.meta,
    transcript,
    events,
    frameTimes: input.frameTimes.filter((t) => t >= lo && t <= hi),
    draft,
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

export async function organizeChunked(
  input: OrganizeInput,
  options: ChunkedOptions,
): Promise<ChunkedResult> {
  const itemsPerChunk = options.itemsPerChunk ?? 10
  const concurrency = options.concurrency ?? 4
  const chunks = splitInput(input, itemsPerChunk)

  const started = Date.now()
  const parts = await mapLimit(chunks, concurrency, (c) => organize(c, options))
  const elapsedMs = Date.now() - started

  const okParts = parts.filter((p): p is Extract<OrganizeResult, { ok: true }> => p.ok)
  const failed = parts.length - okParts.length

  if (okParts.length === 0) {
    return {
      ok: false,
      parts,
      elapsedMs,
      failed,
      reason: parts.find((p) => !p.ok)?.reason ?? '全区間が失敗',
    }
  }

  // 区間をまたぐ重複は、引用の時刻が完全に一致する指摘だけ落とす（境界の余白ぶん）
  const seen = new Set<string>()
  const items: OrganizeOutput['items'] = []
  for (const p of okParts) {
    for (const item of p.output.items) {
      const key = item.quotes.map((q) => q.t).sort((a, b) => a - b).join(',')
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      items.push(item)
    }
  }
  items.sort((a, b) => firstTime(a) - firstTime(b))

  const droppedSeen = new Set<number>()
  const dropped: OrganizeOutput['dropped'] = []
  for (const p of okParts) {
    for (const d of p.output.dropped) {
      if (droppedSeen.has(d.t)) continue
      droppedSeen.add(d.t)
      dropped.push(d)
    }
  }
  dropped.sort((a, b) => a.t - b.t)

  // 区間ごとに名前が付くので、指摘の最も多い区間の名前を全体の名前にする
  const reviewTitle = [...okParts].sort((a, b) => b.output.items.length - a.output.items.length).find((p) => p.output.reviewTitle)?.output.reviewTitle

  return { ok: true, output: { items, dropped, ...(reviewTitle ? { reviewTitle } : {}) }, parts, elapsedMs, failed }
}

function firstTime(item: OrganizeOutput['items'][number]): number {
  const ts = [...item.quotes.map((q) => q.t), ...item.frame_times]
  return ts.length > 0 ? Math.min(...ts) : 0
}
