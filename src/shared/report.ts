import { isUserFacingError } from './errors'

/**
 * 黙って失敗している箇所（catch して既定値で続ける・console.warn だけ）を Sentry へ知らせる入口。
 *
 * main と renderer の両方から呼ぶ。ここは Sentry に依存させず、各プロセスの telemetry
 * （src/main/telemetry.ts、src/renderer/lib/telemetry.ts）が初期化したときに送り先を差し込む。
 * 差し込まれていない起動（設定 OFF・E2E・単体テスト）では何もしない。
 *
 * 送る中身は例外と、どこで（area）・何をしていて（op）だけ。パスや URL は beforeSend の scrub が落とす。
 * 利用者に見せるための想定内のエラー（UserFacingError）は送らない。
 */

/** どの機能の失敗か。Sentry のタグ area になる */
export type ReportArea =
  | 'terminal' | 'pty' | 'agent-launch' | 'recording' | 'stt' | 'organize' | 'review' | 'files' | 'editor'
  | 'browser' | 'github' | 'usage' | 'accounts' | 'update' | 'settings' | 'layout' | 'resources' | 'sessions'
  | 'preview' | 'startup' | 'ui'

export interface ReportWhere {
  area: ReportArea
  /** 何をしていたか（短い英語の動詞句。例: 'read settings'）。可変の値（パス・URL）は入れない */
  op: string
}

export interface Reporter {
  handled(err: unknown, tags: Record<string, string>, level: 'warning' | 'error'): void
  message(message: string, tags: Record<string, string>, level: 'warning' | 'error'): void
  breadcrumb(message: string, data?: Record<string, string | number>): void
}

let reporter: Reporter | null = null
/** 同じ例外を2度送らない（catch で送ったあと、上で投げ直されて IPC でも拾われるなど） */
let seen = new WeakSet<object>()

/**
 * renderer に届いた IPC の失敗（`Error invoking remote method '…'`）。main の wrapIpcHandler が送り済みなので、
 * renderer の catch からは送らない（二重に数えない）
 */
export function isIpcRelay(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Error invoking remote method ')
}

/** telemetry が初期化したときだけ呼ぶ。null で外す（テスト用） */
export function setReporter(next: Reporter | null): void {
  reporter = next
  seen = new WeakSet()
}

/** catch して続ける箇所の失敗を送る。想定外の失敗だけに使う（想定内なら理由のコメントを付けて送らない） */
export function reportHandled(err: unknown, where: ReportWhere, level: 'warning' | 'error' = 'warning'): void {
  if (!reporter || isUserFacingError(err) || isIpcRelay(err)) return
  if (err && typeof err === 'object') {
    if (seen.has(err)) return
    seen.add(err)
  }
  reporter.handled(err, { kind: 'handled', area: where.area, op: where.op }, level)
}

/** 例外ではない異常（性能・異常終了など）を送る */
export function reportAnomaly(message: string, tags: Record<string, string>, level: 'warning' | 'error' = 'warning'): void {
  reporter?.message(message, tags, level)
}

/**
 * 主要な流れの区切り（パンくず）。失敗した直前の操作が分かるように置く。
 * 入れるのは操作名と種類（agent 名・exit code など）だけ。パス・URL・文は入れない。
 */
export function flow(op: string, data?: Record<string, string | number>): void {
  reporter?.breadcrumb(op, data)
}

/**
 * 例外の種類（name と code）だけを持つ例外にする。
 * メッセージに設定ファイルの中身（MCP の鍵など）が入りうる箇所で、reportHandled に渡す前に使う。
 */
export function errorKind(err: unknown): Error {
  const name = err instanceof Error ? err.name : typeof err
  const code = (err as { code?: unknown } | null)?.code
  const out = new Error(typeof code === 'string' ? `${name} ${code}` : name)
  out.name = name
  return out
}
