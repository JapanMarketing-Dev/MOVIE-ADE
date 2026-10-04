/**
 * 指摘ごとの進み具合（未対応・対応中・人の確認待ち・完了）。
 *
 * 旗（status: decided / needs_check）は「指摘の中身が決まったか」、こちらは「Agent が直し終えたか」で別物。
 * Ferret 自身は直ったかを判定しない。Agent が作業しながら、レビューのフォルダの progress.json に書く:
 *
 *   .ferret/reviews/<id>/progress.json
 *   { "i1": "in_progress",
 *     "i2": { "status": "human_review", "after": "after/i2.png", "score": { "noul": 0.92, "choice": "done" } },
 *     "i3": { "status": "human_review", "after": "after/i3.png", "note": "録画の Sign up ボタンは今のヘッダーのボタンと読んだ" } }
 *
 * 流れ: todo → in_progress → human_review →（人が OK）→ done。人が NG なら in_progress に戻して送り直す。
 * - human_review: Agent が直して AFTER を撮ったもの。done にできるのは人だけで、Agent が done を書いても
 *   人の OK（history の最後の判断が ok）が無ければ human_review として読む
 * - Agent は人に質問しない。前提が合わない指摘も意図に沿って直し、仮定を note に1行書いて human_review にする。
 *   判定モデルは Agent が裏で使う自分の確認で、人への問いにはしない。人がするのは BEFORE / AFTER を見て OK / NG だけ
 * - 古いファイル・古い指示の Agent が書いた needs_human は human_review として読む（note は Agent のひとことのまま見せる）
 * - history: 人の判断（OK / NG / Comment）の記録。Ferret が書き、Agent には残すよう頼む
 * - queued: NG を付けたが、まだ Agent へ送り直していない（「NG をまとめて送る」の対象）
 *
 * 値は文字列だけの形（"in_progress"）と、オブジェクトの形のどちらでもよい。利用者が画面で切り替えた値も同じファイルに書く。
 * 書かれていない指摘は未対応。壊れた JSON・知らない値は無視する（Agent が書くので崩れることがある）。
 */
import { sanitizeAfterPath, sanitizeDecisionScore, type DecisionScore } from './afterShot'

export type FindingProgress = 'todo' | 'in_progress' | 'human_review' | 'done'

/** 人の判断。OK で完了、NG で直し直し、Comment は判断せずに残す */
export type ReviewVerdict = 'ok' | 'ng' | 'comment'

interface ReviewEvent {
  /** ISO8601 */
  at: string
  verdict: ReviewVerdict
  text?: string
}

/** ひとこと・コメントの長さの上限。一覧のたびに読むので抑える */
export const PROGRESS_NOTE_MAX = 2000
/** 判断の記録を残す件数（古いものから捨てる） */
const HISTORY_MAX = 50

export interface ProgressEntry {
  status: FindingProgress
  /** Agent が書いたひとこと（何を仮定したか・AFTER が無い理由など。確認のカードに出す） */
  note?: string
  /** 直したあとのスクリーンショット（レビューのフォルダからの相対パス。@shared/afterShot） */
  after?: string
  /** 判定モデルのスコア（人の判断の材料。判定モデルが有効なときだけ） */
  score?: DecisionScore
  /** 人の判断の記録（古い順） */
  history?: ReviewEvent[]
  /** NG を付けたが、まだ Agent へ送り直していない */
  queued?: true
}

/** 指摘のID → 進み具合。書かれていない指摘は未対応 */
export type ProgressMap = Record<string, ProgressEntry>

/**
 * 変更の値。状態だけか、オブジェクトの形。
 * 状態を変えると、渡さなかった note・queued は消える。after・score・history は残す（todo に戻したときは after・score も消す）
 */
export type ProgressPatchValue = FindingProgress | { status: FindingProgress; note?: string; after?: string; score?: DecisionScore; queued?: boolean }

/**
 * 「In progress」「in-progress」「DONE」「human-review」のような書き方の揺れを吸収する。読めなければ null。
 * needs_human（Agent が人に質問していた頃の値）は human_review として読む。人は BEFORE / AFTER を見て OK / NG を付けるだけ
 */
export function normalizeProgress(value: unknown): FindingProgress | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (v === 'needs_human') return 'human_review'
  return v === 'todo' || v === 'in_progress' || v === 'human_review' || v === 'done' ? v : null
}

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, PROGRESS_NOTE_MAX)
  return s || undefined
}

function parseHistory(raw: unknown): ReviewEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.flatMap((e): ReviewEvent[] => {
    if (!e || typeof e !== 'object') return []
    const r = e as Record<string, unknown>
    const verdict = r.verdict === 'ok' || r.verdict === 'ng' || r.verdict === 'comment' ? r.verdict : null
    if (!verdict || typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return []
    const body = text(r.text)
    return [{ at: r.at, verdict, ...(body ? { text: body } : {}) }]
  }).slice(-HISTORY_MAX)
  return out.length ? out : undefined
}

/** 人の最後の判断（OK / NG。Comment は判断ではないので飛ばす） */
export function lastVerdict(entry: ProgressEntry | undefined): 'ok' | 'ng' | null {
  const last = entry?.history?.filter((e) => e.verdict !== 'comment').at(-1)
  return last ? last.verdict as 'ok' | 'ng' : null
}

/** 1件の値を読む（文字列の形・オブジェクトの形）。読めない値・何も持たない todo は null */
function parseEntry(value: unknown): ProgressEntry | null {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  let status = normalizeProgress(obj ? obj.status : value)
  if (!status) return null
  const note = obj ? text(obj.note) : undefined
  const after = obj ? sanitizeAfterPath(obj.after) : undefined
  const score = obj ? sanitizeDecisionScore(obj.score) : undefined
  const history = obj ? parseHistory(obj.history) : undefined
  const queued = obj?.queued === true
  const entry: ProgressEntry = { status, ...(note ? { note } : {}), ...(after ? { after } : {}),
    ...(score ? { score } : {}), ...(history ? { history } : {}), ...(queued ? { queued: true as const } : {}) }
  // done にできるのは人だけ。人の OK が無い done は、人の確認待ちとして読む
  if (status === 'done' && lastVerdict(entry) !== 'ok') status = entry.status = 'human_review'
  // 何も持たない todo は「書かれていない」と同じ
  if (status === 'todo' && !history) return null
  return entry
}

/**
 * progress.json の中身を読む（純粋）。オブジェクトでなければ空。
 * knownIds を渡すと、そのレビューに無い指摘のIDを落とす
 */
export function parseProgress(raw: unknown, knownIds?: Iterable<string>): ProgressMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const known = knownIds ? new Set(knownIds) : null
  const out: ProgressMap = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || (known && !known.has(id))) continue
    const entry = parseEntry(value)
    if (entry) out[id] = entry
  }
  return out
}

/** 変更を1件重ねる（純粋）。status の決まりは ProgressPatchValue のとおり */
function mergeEntry(current: ProgressEntry | undefined, value: ProgressPatchValue): ProgressEntry | null {
  const obj = typeof value === 'object' && value ? value : null
  const status = normalizeProgress(obj ? obj.status : value)
  if (!status) return current ?? null
  const note = obj ? text(obj.note) : undefined
  const after = obj?.after !== undefined ? sanitizeAfterPath(obj.after) : status === 'todo' ? undefined : current?.after
  const score = obj?.score !== undefined ? sanitizeDecisionScore(obj.score) : status === 'todo' ? undefined : current?.score
  const history = current?.history
  const next: ProgressEntry = { status, ...(note ? { note } : {}), ...(after ? { after } : {}),
    ...(score ? { score } : {}), ...(history ? { history } : {}), ...(obj?.queued ? { queued: true as const } : {}) }
  return status === 'todo' && !history ? null : next
}

/** 変更を重ねる。何も持たない todo はファイルから消す */
export function applyProgress(current: ProgressMap, patch: Record<string, ProgressPatchValue>): ProgressMap {
  const out: ProgressMap = { ...current }
  for (const [id, value] of Object.entries(patch)) {
    if (!id) continue
    const next = mergeEntry(out[id], value)
    if (next) out[id] = next
    else delete out[id]
  }
  return out
}

/**
 * 人の判断を記録する（純粋）。OK → done、NG → in_progress（送り直すまで queued）、Comment → 状態は変えない。
 * NG のときも前の AFTER・スコアは残す（Agent が撮り直したら上書きする）
 */
export function applyVerdict(current: ProgressEntry | undefined, verdict: ReviewVerdict, body: string | undefined, at: string): ProgressEntry {
  const event: ReviewEvent = { at, verdict, ...(text(body) ? { text: text(body)! } : {}) }
  const history = [...(current?.history ?? []), event].slice(-HISTORY_MAX)
  const base: ProgressEntry = { ...(current ?? { status: 'todo' }), history }
  if (verdict === 'comment') return base
  const { note: _note, queued: _queued, ...kept } = base
  return verdict === 'ok' ? { ...kept, status: 'done' } : { ...kept, status: 'in_progress', queued: true }
}

/** ファイルへ書く形。状態のほかに何も無ければ文字列だけ（Agent が読み書きしやすいように） */
export function serializeProgress(map: ProgressMap): Record<string, ProgressEntry | ProgressEntry['status']> {
  return Object.fromEntries(Object.entries(map).map(([id, e]) => [id, Object.keys(e).length > 1 ? e : e.status]))
}

export function progressOf(map: ProgressMap | undefined, id: string): FindingProgress {
  return map?.[id]?.status ?? 'todo'
}

/** 画面のボタンで押したときの次（未対応 → 対応中 → 完了 → 未対応）。確認待ちは対応中へ。完了にするのは人の OK として記録する */
export function nextProgress(p: FindingProgress): FindingProgress {
  return p === 'todo' || p === 'human_review' ? 'in_progress' : p === 'in_progress' ? 'done' : 'todo'
}

/** 直近の人のコメント（NG・Comment の本文）。次に送るとき Agent に渡す（新しい順に count 件） */
export function recentComments(entry: ProgressEntry | undefined, count = 3): ReviewEvent[] {
  return (entry?.history ?? []).filter((e) => e.verdict !== 'ok' && e.text).slice(-count).reverse()
}

interface ProgressCount {
  /** 人が OK したもの */
  done: number
  inProgress: number
  /** Agent が直して、人の確認を待っているもの */
  humanReview: number
  /** NG を付けて、まだ送り直していないもの */
  queued: number
  /** 数える対象（Agent へ送る指摘） */
  total: number
}

/** Agent へ送る指摘（include=true）だけを数える。外した指摘は対象外 */
export function countProgress(items: ReadonlyArray<{ id: string; include: boolean }>, map: ProgressMap | undefined): ProgressCount {
  const count: ProgressCount = { done: 0, inProgress: 0, humanReview: 0, queued: 0, total: 0 }
  for (const item of items) {
    if (!item.include) continue
    count.total += 1
    const p = progressOf(map, item.id)
    if (p === 'done') count.done += 1
    else if (p === 'in_progress') count.inProgress += 1
    else if (p === 'human_review') count.humanReview += 1
    if (map?.[item.id]?.queued) count.queued += 1
  }
  return count
}

/**
 * 「Agentへ送信」で送る指摘のID。未対応（todo）で送る対象（include=true）のものだけ。
 * 完了・対応中・人の確認待ちは送り直さない。NG はコメントつきで別に送り直す
 */
export function pendingIds(items: ReadonlyArray<{ id: string; include: boolean }>, map: ProgressMap | undefined): string[] {
  return items.filter((it) => it.include && progressOf(map, it.id) === 'todo').map((it) => it.id)
}

/** NG を付けて、まだ送り直していない指摘のID（「NG をまとめて送る」の対象）。画面の並び順 */
export function queuedIds(items: ReadonlyArray<{ id: string; include: boolean }>, map: ProgressMap | undefined): string[] {
  return items.filter((it) => it.include && map?.[it.id]?.queued).map((it) => it.id)
}

/** 送った指摘（未対応だったもの）を対応中にする変更（「Agentへ送信」のあと）。完了・確認待ちのものは変えない */
export function sentPatch(items: ReadonlyArray<{ id: string; include: boolean }>, map: ProgressMap | undefined): Record<string, FindingProgress> {
  return Object.fromEntries(pendingIds(items, map).map((id) => [id, 'in_progress' as const]))
}

/** fs:changed の相対パスから、進み具合が変わったレビューのIDを拾う */
export function progressChangedIds(paths: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const path of paths) {
    const m = /^\.(?:ferret|ade-movie)\/reviews\/(\d{8}-\d{6})\/progress\.json$/.exec(path.replace(/\\/g, '/'))
    if (m) ids.add(m[1]!)
  }
  return [...ids]
}
