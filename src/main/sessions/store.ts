/**
 * セッションの読み書き（設計 8章）。
 * 録画中は逐次ディスクへ書き、異常終了しても残ったデータから復元できるようにする（NF-12）。
 */
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { SessionPaths } from './paths'
import { sessionId, sessionPaths } from './paths'
import { writeSummary } from './summary'

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
}

export const SESSION_VERSION = 1 as const

/** 新しいセッションのフォルダを作る */
export async function createSession(projectDir: string, now = new Date()): Promise<SessionPaths> {
  let paths = sessionPaths(projectDir, sessionId(now))
  await mkdir(dirname(paths.dir), { recursive: true })
  for (let offset = 0; ; offset++) {
    paths = sessionPaths(projectDir, sessionId(new Date(now.getTime() + offset * 1000)))
    try { await mkdir(paths.dir); break }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
  }
  await mkdir(paths.audioDir, { recursive: true })
  await mkdir(paths.framesDir, { recursive: true })
  return paths
}

// ───────────────────────── 操作ログ（events.jsonl） ─────────────────────────

/** 操作ログを追記する。録画中に何度も呼ばれるので追記のみ（設計 1.3） */
export async function appendEvents(paths: SessionPaths, events: Event[]): Promise<void> {
  if (events.length === 0) return
  const body = events.map((e) => JSON.stringify(e)).join('\n')
  await appendFile(paths.eventsJsonl, `${body}\n`, 'utf8')
}

/** 操作ログを読む。壊れた行は捨てる（異常終了で書きかけの行が残りうる） */
export async function readEvents(paths: SessionPaths): Promise<Event[]> {
  const text = await readFile(paths.eventsJsonl, 'utf8').catch(() => '')
  const out: Event[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as Event)
    } catch {
      // 書きかけの行。捨てる
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

// ───────────────────────── session.json ─────────────────────────

export async function saveSession(paths: SessionPaths, record: SessionRecord): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
  // 書きかけで壊さないよう、一時ファイルへ書いてから差し替える
  const tmp = `${paths.sessionJson}.tmp`
  await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, paths.sessionJson)
  // 一覧用の要約も書き直す（分解の完了・編集のたび）。書けなくても一覧を読むときに作り直す
  await writeSummary(paths, record).catch(() => undefined)
}

export async function loadSession(paths: SessionPaths): Promise<SessionRecord | null> {
  const text = await readFile(paths.sessionJson, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as SessionRecord
    if (parsed.version !== SESSION_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

export function hasSession(paths: SessionPaths): boolean {
  return existsSync(paths.sessionJson)
}

/** 分解が終わったら中間ファイルを消す（設計 8章 work/） */
export async function clearWork(paths: SessionPaths): Promise<void> {
  await rm(paths.workDir, { recursive: true, force: true })
}

/** feedback.md を書く。画像は呼び出し側が保存する */
export async function writeFeedbackMarkdown(paths: SessionPaths, markdown: string): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.feedbackMd, markdown, 'utf8')
}
