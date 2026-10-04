/**
 * 過去のレビュー（セッション）の一覧（要件 OUT-5）。
 * session.json が無い・壊れている場合も、フォルダの中身から分かる範囲を返す。
 */
import { lstat, stat } from 'node:fs/promises'
import { writeFileNoFollow } from './containment'
import { existsSync } from 'node:fs'
import type { SessionPaths } from './paths'
import { listSessionIdsPage, sessionPaths } from './paths'
import { HISTORY_LIMITS } from './limits'
import { readLabel } from './labels'
import { inspect } from './recover'
import { loadSession } from './store'
import { readProgress } from './progress'
import { countProgress } from '@shared/findingProgress'
import { buildStoredSummary, joinSearchText, readFreshSummary, readNavs } from './summary'
import { reportHandled } from '@shared/report'

interface SessionSummary {
  id: string
  dir: string
  /** 収録開始（ISO8601）。session.json が読めなければフォルダ名から組み立てる */
  startedAt: string
  durationMs: number
  /** 送信対象の指摘の件数。分解前なら 0 */
  itemCount: number
  /** 「要確認」として送信対象から外した件数 */
  needsCheckCount: number
  /** 進み具合の対象（Agent へ送る指摘）の件数 */
  includedCount: number
  /** そのうち完了した件数（progress.json） */
  doneCount: number
  /** Agent が人間へ戻した（確認待ち）件数 */
  needsHumanCount: number
  /** Agent が直して人の確認を待っている（human_review）件数 */
  humanReviewCount: number
  targetUrl?: string
  hasFeedback: boolean
  /** 動画が残っているか（保持期間を過ぎると消える。NF-8） */
  hasRecording: boolean
  /** 分解が未完了（session.json が無い・壊れている） */
  incomplete: boolean
  /** session.json が壊れていて、復元できる素材も無い（開けない） */
  broken?: boolean
  /** 利用者が付けた名前 */
  name?: string
  /** 録ったページのタイトル（最初の遷移） */
  title?: string
  /** 自動の名前（何系の修正か）。手の名前（name）があっても控える。見出しは name → autoName → title */
  autoName?: string
  /** 一覧から隠した */
  archived?: boolean
  /** Agent へ送った時刻 */
  sentAt?: string
  /** 検索用の本文（ページのタイトル・URL・指摘の本文） */
  searchText?: string
  /** 一覧1回の上限を超えたので、要約をまだ読んでいない（次の一覧か、開いたときに読む。security-4 [10]） */
  pending?: true
}

/** 一覧の結果。truncated は上限（HISTORY_LIMITS.listed など）でこれより古いものを返していないとき */
interface SessionListPage {
  sessions: SessionSummary[]
  truncated: boolean
}

/**
 * 一覧1回の読む量と時間の残り（security-4 [10]）。summary.json の無い記録の組み立ては、ここで許された数だけ
 */
class ListBudget {
  private bytesLeft: number
  private heavyLeft: number
  private readonly deadline: number
  constructor(limits: { readBytes: number; heavyBuilds: number; budgetMs: number } = HISTORY_LIMITS, private readonly now: () => number = Date.now) {
    this.bytesLeft = limits.readBytes
    this.heavyLeft = limits.heavyBuilds
    this.deadline = now() + limits.budgetMs
  }

  get exhausted(): boolean {
    return this.bytesLeft <= 0 || this.now() >= this.deadline
  }

  /** 読む前に大きさを数える。残りを超えるなら false（読まない）。無いファイルは 0 */
  async charge(...files: string[]): Promise<boolean> {
    if (this.exhausted) return false
    let total = 0
    for (const file of files) total += (await lstat(file).catch(() => null))?.size ?? 0
    if (total > this.bytesLeft) {
      this.bytesLeft = 0
      return false
    }
    this.bytesLeft -= total
    return true
  }

  /** summary.json の無い記録を組み立ててよいか（数・大きさ・時間） */
  async takeHeavy(...files: string[]): Promise<boolean> {
    if (this.heavyLeft <= 0) return false
    if (!(await this.charge(...files))) return false
    this.heavyLeft -= 1
    return true
  }
}

/** 新しい順に返す（上限の内側だけ。listSessionsPage） */
export async function listSessions(projectDir: string): Promise<SessionSummary[]> {
  return (await listSessionsPage(projectDir)).sessions
}

/**
 * 新しい順に、件数・読む量・時間の上限の内側で一覧を作る（security-4 [10]）。
 * summary.json の無い・古い記録の組み立て（session.json の解析）は1回に数件だけ。残りは軽い形（pending）で返し、
 * 次の一覧か、その記録を開いたときに組み立てる
 */
export async function listSessionsPage(projectDir: string, limits: { readonly [K in keyof typeof HISTORY_LIMITS]: number } = HISTORY_LIMITS, now: () => number = Date.now): Promise<SessionListPage> {
  // .ferret/ と改名前の .ade-movie/ の両方（まだ録画していないプロジェクトにはフォルダが無い。想定内）
  const page = await listSessionIdsPage(projectDir, { max: limits.listed, scannedNames: limits.scannedNames })
  const budget = new ListBudget(limits, now)
  const out: SessionSummary[] = []

  for (const name of page.ids) {
    const paths = sessionPaths(projectDir, name)
    // 一覧のあとに消されたものは飛ばす（想定内）
    const s = await stat(paths.dir).catch(() => null)
    if (!s?.isDirectory()) continue
    out.push(await summarize(paths, budget))
  }
  return { sessions: out.sort((a, b) => (a.id < b.id ? 1 : -1)), truncated: page.truncated }
}

/** セットアップの確認（録画したか・送ったか）で見る、新しい記録の数（全部の履歴は読まない。security-4 [10]） */
export const ACTIVITY_SCAN = 50

/**
 * 録画したことがあるか・Agent へ送ったことがあるか。新しい順に ACTIVITY_SCAN 件まで、名前（label.json）だけを読む
 */
export async function sessionActivity(projectDir: string): Promise<{ recorded: boolean; sent: boolean }> {
  const { ids } = await listSessionIdsPage(projectDir, { max: ACTIVITY_SCAN })
  let sent = false
  for (const id of ids) {
    if ((await readLabel(sessionPaths(projectDir, id))).sentAt) {
      sent = true
      break
    }
  }
  return { recorded: ids.length > 0, sent }
}

/** 一覧の上限を超えた記録の軽い形（ファイルは読まない。フォルダ名の日時だけ） */
function pendingSummary(paths: SessionPaths): SessionSummary {
  return {
    id: paths.id,
    dir: paths.dir,
    startedAt: startedAtFromId(paths.id),
    durationMs: 0,
    itemCount: 0,
    needsCheckCount: 0,
    includedCount: 0,
    doneCount: 0,
    needsHumanCount: 0,
    humanReviewCount: 0,
    hasFeedback: existsSync(paths.feedbackMd),
    hasRecording: existsSync(paths.recording),
    incomplete: false,
    pending: true
  }
}

export async function summarize(paths: SessionPaths, budget: ListBudget = new ListBudget({ readBytes: Number.POSITIVE_INFINITY, heavyBuilds: Number.POSITIVE_INFINITY, budgetMs: Number.POSITIVE_INFINITY })): Promise<SessionSummary> {
  // 小さなファイル（名前・要約・進み具合）も、一覧1回の合計で数える（細工した大量の記録で止まらない）
  if (!(await budget.charge(paths.labelJson, paths.summaryJson, paths.progressJson))) return pendingSummary(paths)
  const hasFeedback = existsSync(paths.feedbackMd)
  const hasRecording = existsSync(paths.recording)
  const label = await readLabel(paths)

  // 一覧用の要約（summary.json）があれば、それだけで足りる
  let stored = await readFreshSummary(paths)
  if (!stored) {
    // 要約の無い・古い記録の組み立て（session.json・操作ログの解析）は、一覧1回に数件だけ（security-4 [10]）
    if (!(await budget.takeHeavy(paths.sessionJson, paths.eventsJsonl))) return { ...pendingSummary(paths), ...label }
    const record = await loadSession(paths)
    if (!record) {
      // 分解が終わっていない（落ちた）レビュー。数が少ないので、その場で操作ログを読む
      const broken = existsSync(paths.sessionJson) && !(await inspect(paths)).worthRecovering
      const navs = await readNavs(paths)
      const title = navs.find((n) => n.title)?.title
      const searchText = joinSearchText([label.name, ...navs.flatMap((n) => [n.title, n.url])])
      return {
        id: paths.id,
        dir: paths.dir,
        startedAt: startedAtFromId(paths.id),
        durationMs: 0,
        itemCount: 0,
        needsCheckCount: 0,
        includedCount: 0,
        doneCount: 0,
        needsHumanCount: 0,
        humanReviewCount: 0,
        hasFeedback,
        hasRecording,
        incomplete: true,
        ...(broken ? { broken } : {}),
        ...label,
        ...(title ? { title } : {}),
        ...(searchText ? { searchText } : {})
      }
    }
    // summary.json が無い古いレビュー。1度だけ作って控える
    stored = buildStoredSummary(record, await readNavs(paths))
    // 書けなくても次に一覧を読むときに作り直す。書けないこと自体は想定外なので知らせる
    await writeFileNoFollow(paths.summaryJson, `${JSON.stringify(stored)}\n`).catch((err: unknown) => reportHandled(err, { area: 'sessions', op: 'write summary cache' }))
  }

  const searchText = joinSearchText([label.name, stored.searchText])
  const progress = countProgress(stored.includedIds.map((id) => ({ id, include: true })), await readProgress(paths))
  return {
    id: paths.id,
    dir: paths.dir,
    startedAt: stored.startedAt,
    durationMs: stored.durationMs,
    itemCount: stored.itemCount,
    needsCheckCount: stored.needsCheckCount,
    includedCount: progress.total,
    doneCount: progress.done,
    needsHumanCount: progress.needsHuman,
    humanReviewCount: progress.humanReview,
    ...(stored.targetUrl ? { targetUrl: stored.targetUrl } : {}),
    hasFeedback,
    hasRecording,
    incomplete: false,
    ...label,
    ...(stored.title ? { title: stored.title } : {}),
    ...(stored.autoName ? { autoName: stored.autoName } : {}),
    ...(searchText ? { searchText } : {})
  }
}

/** `20261002-104012` → ISO8601（ローカル時刻として解釈） */
export function startedAtFromId(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id)
  if (!m) return id
  const [, y, mo, d, h, mi, s] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return date.toISOString()
}
