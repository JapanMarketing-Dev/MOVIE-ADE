/**
 * 過去のレビュー（セッション）の一覧（要件 OUT-5）。
 * session.json が無い・壊れている場合も、フォルダの中身から分かる範囲を返す。
 */
import { readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { SessionPaths } from './paths'
import { isSessionId, reviewsRoot, sessionPaths } from './paths'
import { readLabel } from './labels'
import { inspect } from './recover'
import { loadSession } from './store'
import { buildStoredSummary, joinSearchText, readFreshSummary, readNavs } from './summary'
import { reportHandled } from '@shared/report'

export interface SessionSummary {
  id: string
  dir: string
  /** 収録開始（ISO8601）。session.json が読めなければフォルダ名から組み立てる */
  startedAt: string
  durationMs: number
  /** 送信対象の指摘の件数。分解前なら 0 */
  itemCount: number
  /** 「要確認」として送信対象から外した件数 */
  needsCheckCount: number
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
  /** 一覧から隠した */
  archived?: boolean
  /** Agent へ送った時刻 */
  sentAt?: string
  /** 検索用の本文（ページのタイトル・URL・指摘の本文） */
  searchText?: string
}

/** 新しい順に返す */
export async function listSessions(projectDir: string): Promise<SessionSummary[]> {
  const root = reviewsRoot(projectDir)
  // まだ録画していないプロジェクトにはフォルダが無い（想定内）
  const names = await readdir(root).catch(() => [] as string[])
  const out: SessionSummary[] = []

  for (const name of names) {
    if (!isSessionId(name)) continue
    const paths = sessionPaths(projectDir, name)
    // 一覧のあとに消されたものは飛ばす（想定内）
    const s = await stat(paths.dir).catch(() => null)
    if (!s?.isDirectory()) continue
    out.push(await summarize(paths))
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1))
}

export async function summarize(paths: SessionPaths): Promise<SessionSummary> {
  const hasFeedback = existsSync(paths.feedbackMd)
  const hasRecording = existsSync(paths.recording)
  const label = await readLabel(paths)

  // 一覧用の要約（summary.json）があれば、それだけで足りる
  let stored = await readFreshSummary(paths)
  if (!stored) {
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
    await writeFile(paths.summaryJson, `${JSON.stringify(stored)}\n`, 'utf8').catch((err: unknown) => reportHandled(err, { area: 'sessions', op: 'write summary cache' }))
  }

  const searchText = joinSearchText([label.name, stored.searchText])
  return {
    id: paths.id,
    dir: paths.dir,
    startedAt: stored.startedAt,
    durationMs: stored.durationMs,
    itemCount: stored.itemCount,
    needsCheckCount: stored.needsCheckCount,
    ...(stored.targetUrl ? { targetUrl: stored.targetUrl } : {}),
    hasFeedback,
    hasRecording,
    incomplete: false,
    ...label,
    ...(stored.title ? { title: stored.title } : {}),
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
