/**
 * レビューの記録（session.json・JSONL・画像）を読むときの上限と、形の確かめ（CWE-400）。
 *
 * レビューのフォルダはプロジェクトの中にあり、取ってきたリポジトリ・zip に細工した記録が入っていることもある。
 * 巨大なファイル・桁外れの件数・深い入れ子をそのまま信じて読むと、main がメモリや CPU を使い切って止まる。
 * - ファイルは大きさを見てから読む（containment.ts の readFileNoFollow が上限で断る）
 * - session.json は版だけでなく、形と件数を確かめる。合わなければ壊れた記録として扱う
 * - JSONL は行数と1行の長さにも上限を置く
 * - 最大・最小は可変長引数（Math.max(...xs)）で求めない（引数の数の上限を超えると投げる）
 */
import { readFileNoFollow } from './containment'

/** 件数・長さの上限。普通の録画（数十分・指摘数百件）の何倍もの余裕を取ってある */
export const SESSION_LIMITS = {
  /** session.json の大きさ */
  sessionJsonBytes: 64 * 1024 * 1024,
  /** 一覧用の小さな JSON（summary.json・label.json・capture.json） */
  smallJsonBytes: 1024 * 1024,
  /** JSONL（events.jsonl・frames.jsonl・transcript.jsonl） */
  jsonlBytes: 64 * 1024 * 1024,
  jsonlLines: 500_000,
  jsonlLineBytes: 64 * 1024,
  items: 10_000,
  transcript: 200_000,
  frames: 200_000,
  draft: 50_000,
  edits: 100_000,
  dropped: 50_000,
  takes: 1_000,
  notes: 1_000,
  /** 指摘1件の中の配列（引用・画像の時刻・書き込み・下書きID） */
  perItem: 5_000,
  /** 指摘1件の画像（ファイル名・時刻） */
  imagesPerItem: 10,
  idChars: 200,
  /** 見出し・要望・補足・発話1つの長さ */
  textChars: 200_000,
  /** 確認画面に渡す画像（生成した ./01.png …） */
  images: 500,
  imageBytes: 10 * 1024 * 1024,
  imagesTotalBytes: 96 * 1024 * 1024
} as const

/**
 * レビューの一覧（review:list）1回でする仕事の上限（security-4 [10]）。
 * 1件ごとの上限（SESSION_LIMITS）だけでは、細工したレビューのフォルダを大量に置かれると、
 * 起動・プロジェクトの切り替え・セットアップの確認のたびに一覧が止まる。件数・読む量・時間の合計を抑える
 */
export const HISTORY_LIMITS = {
  /** 新しい順に返す件数。これより古いものは返さない（truncated） */
  listed: 500,
  /** 1つのフォルダで名前を見る数（readdir を全部メモリへ載せない） */
  scannedNames: 20_000,
  /** summary.json が無い・古い記録を、その場で組み立てる（session.json を解析する）数 */
  heavyBuilds: 4,
  /** 一覧1回で読むファイルの大きさの合計（要約・名前・進み具合と、組み立てる記録） */
  readBytes: 128 * 1024 * 1024,
  /** 一覧1回にかける時間。超えたら残りは読まずに軽い形で返す */
  budgetMs: 3000
} as const

/** 数の配列の最大（空なら fallback）。可変長引数を使わない */
export function maxOf(values: Iterable<number>, fallback: number): number {
  let out = fallback
  for (const v of values) if (Number.isFinite(v) && v > out) out = v
  return out
}

/**
 * JSONL を上限付きで読む。大きすぎるファイルは読まずに空、長すぎる行と書きかけの行は飛ばし、行数は上限で打ち切る。
 * 無い・読めないファイルは空（想定内）
 */
export async function readJsonLines<T>(file: string, limits: { maxBytes?: number; maxLines?: number; maxLineBytes?: number } = {}): Promise<T[]> {
  const maxLines = limits.maxLines ?? SESSION_LIMITS.jsonlLines
  const maxLineBytes = limits.maxLineBytes ?? SESSION_LIMITS.jsonlLineBytes
  const text = await readFileNoFollow(file, 'utf8', { maxBytes: limits.maxBytes ?? SESSION_LIMITS.jsonlBytes }).catch(() => '')
  const out: T[] = []
  let start = 0
  while (start < text.length && out.length < maxLines) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const line = text.slice(start, end).trim()
    start = end + 1
    if (!line || line.length > maxLineBytes) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // 書きかけの行（異常終了）。捨てる
    }
  }
  return out
}

/** JSONL の中身のある行の数（上限で打ち切る） */
export async function countJsonLines(file: string): Promise<number> {
  const text = await readFileNoFollow(file, 'utf8', { maxBytes: SESSION_LIMITS.jsonlBytes }).catch(() => '')
  let count = 0
  let start = 0
  while (start < text.length && count < SESSION_LIMITS.jsonlLines) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    if (text.slice(start, end).trim()) count++
    start = end + 1
  }
  return count
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown, max: number = SESSION_LIMITS.textChars): v is string => typeof v === 'string' && v.length <= max
const arrayWithin = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max
const optionalArray = (v: unknown, max: number) => v === undefined || arrayWithin(v, max)

/** 指摘1件の形。確認画面・feedback.md・編集が使う項目だけを確かめる */
function itemProblem(item: unknown): string | null {
  if (!isObject(item)) return 'item is not an object'
  if (!isText(item.id, SESSION_LIMITS.idChars) || !item.id) return 'item id'
  if (!isNum(item.t)) return 'item t'
  if (!isText(item.title) || !isText(item.request)) return 'item text'
  if (!arrayWithin(item.images, SESSION_LIMITS.imagesPerItem) || !item.images.every((x) => isText(x, 200))) return 'item images'
  if (!arrayWithin(item.frameTimes, SESSION_LIMITS.imagesPerItem) || !item.frameTimes.every(isNum)) return 'item frameTimes'
  if (!arrayWithin(item.quotes, SESSION_LIMITS.perItem) || !item.quotes.every((q) => isObject(q) && isNum(q.t) && isText(q.text))) return 'item quotes'
  if (!optionalArray(item.annotationIds, SESSION_LIMITS.perItem) || !optionalArray(item.draftIds, SESSION_LIMITS.perItem)) return 'item ids'
  if (item.context !== undefined && !isObject(item.context)) return 'item context'
  return null
}

function documentProblem(doc: unknown): string | null {
  if (!isObject(doc)) return 'document is not an object'
  if (!arrayWithin(doc.items, SESSION_LIMITS.items)) return 'too many items'
  for (const item of doc.items) {
    const problem = itemProblem(item)
    if (problem) return problem
  }
  if (!optionalArray(doc.dropped, SESSION_LIMITS.dropped)) return 'too many dropped'
  if (doc.note !== undefined && !isText(doc.note)) return 'note'
  return null
}

/**
 * session.json の形と件数を確かめる。合わなければ理由（調査用。利用者の文章は含めない）、合えば null。
 * 版（version: 1）はここでは見ない（読み手が見る）
 */
export function sessionRecordProblem(raw: unknown): string | null {
  if (!isObject(raw)) return 'not an object'
  const meta = raw.meta
  if (!isObject(meta) || !isText(meta.id, SESSION_LIMITS.idChars) || !isNum(meta.durationMs) || meta.durationMs < 0) return 'meta'
  if (!arrayWithin(raw.transcript, SESSION_LIMITS.transcript)) return 'too many transcript segments'
  if (!optionalArray(raw.removedDuplicates, SESSION_LIMITS.transcript)) return 'too many removed duplicates'
  if (!arrayWithin(raw.frames, SESSION_LIMITS.frames) || !raw.frames.every((f) => isObject(f) && isNum(f.t) && isText(f.path, 500))) return 'frames'
  if (!optionalArray(raw.draft, SESSION_LIMITS.draft)) return 'too many drafts'
  if (!arrayWithin(raw.edits, SESSION_LIMITS.edits) || !raw.edits.every(isObject)) return 'edits'
  if (!optionalArray(raw.takes, SESSION_LIMITS.takes) || !optionalArray(raw.trimFailures, SESSION_LIMITS.takes)) return 'too many takes'
  if (!optionalArray(raw.captureGaps, SESSION_LIMITS.notes)) return 'too many capture gaps'
  const docProblem = documentProblem(raw.document)
  if (docProblem) return `document: ${docProblem}`
  if (raw.originalDocument !== undefined) {
    const original = documentProblem(raw.originalDocument)
    if (original) return `originalDocument: ${original}`
  }
  return null
}
