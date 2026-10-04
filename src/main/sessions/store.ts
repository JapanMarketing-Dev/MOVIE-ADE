/**
 * セッションの読み書き（設計 8章）。
 * 録画中は逐次ディスクへ書き、異常終了しても残ったデータから復元できるようにする（NF-12）。
 */
import { lstat } from 'node:fs/promises'
import { FileTooLargeError } from '../boundedFile'
import { readJsonLines, SESSION_LIMITS, sessionRecordProblem } from './limits'
import { appendFileNoFollow, assertContained, mkdirContained, readFileNoFollow, removeContained, writeFileNoFollow } from './containment'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type {
  DraftItem,
  Event,
  FeedbackDocument,
  FrameRef,
  SessionMeta,
  TranscriptSegment
} from '../pipeline/types'
import type { ValidationIssue } from '../pipeline/organize/index'
import type { ItemEdit } from './edits'
import type { TrimFailure, TrimRecord } from './trim'
import type { SessionPaths } from './paths'
import { ADE_DIR, LEGACY_ADE_DIR, sessionId, sessionPaths } from './paths'
import { writeSummary } from './summary'
import { errorKind, reportHandled } from '@shared/report'

/** session.json の中身 */
export interface SessionRecord {
  version: 1
  meta: SessionMeta
  /** マージ・二重取り除去の後の文字起こし */
  transcript: TranscriptSegment[]
  /** 二重取りとして捨てたマイク側の発話。確認画面で復元できるように残す（AUD-3） */
  removedDuplicates: TranscriptSegment[]
  frames: FrameRef[]
  draft: DraftItem[]
  /** LLM整理の記録。失敗時も理由を残す */
  llm?: {
    runner: string
    model?: string
    ok: boolean
    reason?: string
    elapsedMs: number
    commandLine?: string
    /** LLM が返した生のJSON（調査用） */
    raw?: string
    issues: ValidationIssue[]
  }
  /** 確認画面に出す指摘一覧（編集を適用した後の状態） */
  originalDocument?: FeedbackDocument
  document: FeedbackDocument
  /** 確認画面での編集の履歴。feedback.md はここから再生成する */
  edits: ItemEdit[]
  captureGaps?: string[]
  /**
   * あとから追記した録画（2 本目から。takes.ts）。無ければ録画は1本だけ（古いレビューもこの形）。
   * transcript・frames・draft・events.jsonl には、ここの offsetMs だけずらした時刻で足してある
   */
  takes?: TakeRecord[]
  /** 最初の録画の何もない時間を削った版（trim.ts）。無ければ元の動画だけ。追記した録画の分は takes[].trim */
  trim?: TrimRecord
  /** 削った版を作れなかった録画（元の動画のまま使う。trim.ts の withTrimFailure） */
  trimFailures?: TrimFailure[]
}

/** 追記した録画1本の控え */
export interface TakeRecord {
  /** 2, 3 … （ファイルは takes/<n>/） */
  n: number
  /** レビューの時間軸での開始（ms） */
  offsetMs: number
  durationMs: number
  /** 録画を始めた実時刻（ISO8601） */
  startedAt: string
  /** このレビューに足した時刻（ISO8601）。送った時刻（label.json の sentAt）と比べて未送信を見分ける */
  addedAt: string
  /** この録画の何もない時間を削った版（trim.ts） */
  trim?: TrimRecord
}

const SESSION_VERSION = 1 as const

/** 新しいセッションのフォルダを作る */
export async function createSession(projectDir: string, now = new Date()): Promise<SessionPaths> {
  let paths = sessionPaths(projectDir, sessionId(now), ADE_DIR)
  // 1段ずつ、親を開いて持ったまま作る（containment.ts）。作った直後にもう一度確かめる
  await mkdirContained(dirname(paths.dir), { root: projectDir })
  assertContained(projectDir, dirname(paths.dir))
  for (let offset = 0; ; offset++) {
    paths = sessionPaths(projectDir, sessionId(new Date(now.getTime() + offset * 1000)), ADE_DIR)
    // 改名前の .ade-movie/ に同じ ID があれば避ける（一覧で片方が隠れないように）
    if (existsSync(sessionPaths(projectDir, paths.id, LEGACY_ADE_DIR).dir)) continue
    try { await mkdirContained(paths.dir, { root: projectDir, exclusive: true }); break }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
  }
  // レビューのフォルダは排他で作ったばかりなので、中に先回りのリンクは無い
  await mkdirContained(paths.audioDir, { root: projectDir })
  await mkdirContained(paths.framesDir, { root: projectDir })
  assertContained(projectDir, paths.framesDir)
  return paths
}

// ───────────────────────── 操作ログ（events.jsonl） ─────────────────────────

/** 操作ログを追記する。録画中に何度も呼ばれるので追記のみ（設計 1.3） */
export async function appendEvents(paths: SessionPaths, events: Event[]): Promise<void> {
  if (events.length === 0) return
  const body = events.map((e) => JSON.stringify(e)).join('\n')
  await appendFileNoFollow(paths.eventsJsonl, `${body}\n`)
}

/** 操作ログを読む。壊れた行は捨てる（異常終了で書きかけの行が残りうる） */
export async function readEvents(paths: SessionPaths): Promise<Event[]> {
  // 内蔵ブラウザ以外の録画には操作ログが無い（想定内）。行数・1行の長さ・大きさの上限付きで読む（limits.ts）
  const out = (await readJsonLines<Event>(paths.eventsJsonl)).filter((e) => !!e && typeof e === 'object' && Number.isFinite(e.t))
  return out.sort((a, b) => a.t - b.t)
}

// ───────────────────────── session.json ─────────────────────────

export async function saveSession(paths: SessionPaths, record: SessionRecord): Promise<void> {
  await mkdirContained(paths.dir)
  // 書きかけで壊さないよう、一時ファイルへ書いてから差し替える（末端のリンクはたどらない）
  await writeFileNoFollow(paths.sessionJson, JSON.stringify(record, null, 2))
  // 一覧用の要約も書き直す（分解の完了・編集のたび）。書けなくても一覧を読むときに作り直す
  await writeSummary(paths, record).catch((err: unknown) => reportHandled(err, { area: 'sessions', op: 'write summary' }))
}

/** 形の合わなかった session.json（パス・大きさ・更新時刻）。変わるまで読み直さない */
const rejectedSessions = new Set<string>()

export async function loadSession(paths: SessionPaths): Promise<SessionRecord | null> {
  // 形の合わなかった session.json は、変わるまで読み直さない（一覧のたびに大きなファイルを解析しない）
  const st = await lstat(paths.sessionJson).catch(() => null)
  const key = st ? `${paths.sessionJson}:${st.size}:${st.mtimeMs}` : null
  if (key && rejectedSessions.has(key)) return null
  // まだ分解していない録画には session.json が無い（想定内）。大きすぎるものは読まない（limits.ts）
  let text: string | null
  try {
    text = await readFileNoFollow(paths.sessionJson, 'utf8', { maxBytes: SESSION_LIMITS.sessionJsonBytes })
  } catch (err) {
    if (err instanceof FileTooLargeError && key) rejectedSessions.add(key)
    text = null
  }
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as SessionRecord
    if (parsed.version !== SESSION_VERSION) return null
    // 版だけでなく形と件数も確かめる（細工された記録で main が止まらないように）。合わなければ壊れた記録として扱う
    const problem = sessionRecordProblem(parsed)
    if (problem) {
      if (key) rejectedSessions.add(key)
      reportHandled(new Error(`invalid session.json: ${problem}`), { area: 'sessions', op: 'validate session' })
      return null
    }
    return parsed
  } catch (err) {
    // 壊れた session.json。文字起こしや指摘を含むので、例外の種類だけを送る
    reportHandled(errorKind(err), { area: 'sessions', op: 'parse session' })
    return null
  }
}

/** 分解が終わったら中間ファイルを消す（設計 8章 work/） */
export async function clearWork(paths: SessionPaths): Promise<void> {
  await removeContained(paths.dir, paths.workDir, { recursive: true })
}

/** feedback.md を書く。画像は呼び出し側が保存する */
export async function writeFeedbackMarkdown(paths: SessionPaths, markdown: string): Promise<void> {
  await mkdirContained(paths.dir)
  await writeFileNoFollow(paths.feedbackMd, markdown)
}
