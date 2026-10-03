/**
 * 指摘ごとの進み具合（未対応・対応中・完了・人間の確認待ち）。
 *
 * 旗（status: decided / needs_check）は「指摘の中身が決まったか」、こちらは「Agent が直し終えたか」で別物。
 * Ferret 自身は直ったかを判定しない。Agent が作業しながら、レビューのフォルダの progress.json に書く:
 *
 *   .ferret/reviews/<id>/progress.json
 *   { "i1": "done", "i2": { "status": "needs_human", "note": "録画の Sign up ボタンは今のコードに無い" } }
 *
 * 値は文字列だけの形（"in_progress" / "done"）と、理由つきの形（{ status, note }）のどちらでもよい。
 * needs_human は前提が合わない指摘（録画が古い・指す要素が無い・指摘どうしが矛盾・判断が要る）を Agent が直さずに戻したもの。
 * 人間が Ferret で返答すると reply に残し、対応中へ戻して送り直す。
 *
 * 利用者が画面で切り替えた値も同じファイルに書く（どちらが書いても同じ結果になる）。
 * 書かれていない指摘は未対応。壊れた JSON・知らない値は無視する（Agent が書くので崩れることがある）。
 */

export type FindingProgress = 'todo' | 'in_progress' | 'done' | 'needs_human'

/** レビューのフォルダに置くファイル名 */
export const PROGRESS_FILE = 'progress.json'

/** 理由・返答の長さの上限。一覧のたびに読むので抑える */
export const PROGRESS_NOTE_MAX = 2000

export interface ProgressEntry {
  status: Exclude<FindingProgress, 'todo'>
  /** Agent が書いた理由（needs_human のとき人間へ見せる） */
  note?: string
  /** 人間の返答（Ferret から送り直したもの） */
  reply?: string
}

/** 指摘のID → 進み具合。未対応（todo）は持たない */
export type ProgressMap = Record<string, ProgressEntry>

/** 変更の値。状態だけか、理由・返答つき。状態を変えると、渡さなかった理由・返答は消える */
export type ProgressPatchValue = FindingProgress | { status: FindingProgress; note?: string; reply?: string }

/** 「In progress」「in-progress」「DONE」「needs human」のような書き方の揺れを吸収する。読めなければ null */
export function normalizeProgress(value: unknown): FindingProgress | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return v === 'todo' || v === 'in_progress' || v === 'done' || v === 'needs_human' ? v : null
}

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, PROGRESS_NOTE_MAX)
  return s || undefined
}

/** 1件の値を読む（文字列の形・オブジェクトの形）。todo・読めない値は null */
function parseEntry(value: unknown): ProgressEntry | null {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const status = normalizeProgress(obj ? obj.status : value)
  if (!status || status === 'todo') return null
  const note = obj ? text(obj.note) : undefined
  const reply = obj ? text(obj.reply) : undefined
  return { status, ...(note ? { note } : {}), ...(reply ? { reply } : {}) }
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

/** 変更を重ねる。todo はファイルから消す */
export function applyProgress(current: ProgressMap, patch: Record<string, ProgressPatchValue>): ProgressMap {
  const out: ProgressMap = { ...current }
  for (const [id, value] of Object.entries(patch)) {
    if (!id) continue
    if (normalizeProgress(typeof value === 'object' && value ? value.status : value) === 'todo') { delete out[id]; continue }
    const entry = parseEntry(value)
    if (entry) out[id] = entry
  }
  return out
}

/** ファイルへ書く形。理由・返答が無ければ文字列だけ（Agent が読み書きしやすいように） */
export function serializeProgress(map: ProgressMap): Record<string, ProgressEntry | ProgressEntry['status']> {
  return Object.fromEntries(Object.entries(map).map(([id, e]) => [id, e.note || e.reply ? e : e.status]))
}

export function progressOf(map: ProgressMap | undefined, id: string): FindingProgress {
  return map?.[id]?.status ?? 'todo'
}

/** 画面のボタンで押したときの次（未対応 → 対応中 → 完了 → 未対応）。確認待ちは対応中へ */
export function nextProgress(p: FindingProgress): FindingProgress {
  return p === 'todo' || p === 'needs_human' ? 'in_progress' : p === 'in_progress' ? 'done' : 'todo'
}

export interface ProgressCount {
  done: number
  inProgress: number
  /** Agent が人間へ戻した（確認待ち）件数 */
  needsHuman: number
  /** 数える対象（Agent へ送る指摘） */
  total: number
}

/** Agent へ送る指摘（include=true）だけを数える。外した指摘は対象外 */
export function countProgress(items: ReadonlyArray<{ id: string; include: boolean }>, map: ProgressMap | undefined): ProgressCount {
  const count: ProgressCount = { done: 0, inProgress: 0, needsHuman: 0, total: 0 }
  for (const item of items) {
    if (!item.include) continue
    count.total += 1
    const p = progressOf(map, item.id)
    if (p === 'done') count.done += 1
    else if (p === 'in_progress') count.inProgress += 1
    else if (p === 'needs_human') count.needsHuman += 1
  }
  return count
}

/** 送った指摘のうち未対応のものを対応中にする変更（「Agentへ送信」のあと）。完了・確認待ちのものは変えない */
export function sentPatch(items: ReadonlyArray<{ id: string; include: boolean }>, map: ProgressMap | undefined): Record<string, FindingProgress> {
  return Object.fromEntries(items.filter((it) => it.include && progressOf(map, it.id) === 'todo').map((it) => [it.id, 'in_progress' as const]))
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
