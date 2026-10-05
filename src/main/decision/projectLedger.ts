/**
 * 判定の中継の、プロジェクトごとのその日の使った量を、ファイルに残す（security-6 [8]）。
 *
 * 中継の中（メモリ）だけで数えると、Ferret を起動し直す・中継を立て直すたびに、同じ日のプロジェクトの枠が空に戻る。
 * そこで main が持つフォルダ（userData）の小さな JSON に、その日の回数と費用を残し、中継は数える前に毎回読み直して大きい方を使う
 * （同じファイルを使うほかの中継が数えた分も落とさない）。
 *   - 書くのは一時ファイルに書いてから rename（途中で落ちても半端なファイルを残さない）。中身は数だけ（プロジェクトの ID・日付・回数・費用）
 *   - 送っている途中の依頼の予約は、使ったものとして書く（応答の前に落ちても、起動し直したら予約の分は使ったことになる）
 *   - 日付が変わった記録は読むときに捨てる。プロジェクトの数・ファイルの大きさに上限がある
 *
 * Electron に依存させない（単体テストで一時フォルダに書くため）。
 */
import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

export interface ProjectLedgerEntry {
  /** ローカル時刻の日付（YYYY-M-D） */
  day: string
  calls: number
  usd: number
  /** その日の1回の呼び出しで見た最大（次の予約に使う） */
  maxCallTokens: number
  maxCallUsd: number
}

/** 中継が使う口（テストではメモリの偽物を渡せる） */
export interface ProjectUsageStore {
  load(): Map<string, ProjectLedgerEntry>
  save(entries: Map<string, ProjectLedgerEntry>): void
}

const MAX_PROJECTS = 500
const MAX_FILE_BYTES = 256 * 1024

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

export class ProjectLedger implements ProjectUsageStore {
  constructor(private readonly file: string) {}

  load(): Map<string, ProjectLedgerEntry> {
    const map = new Map<string, ProjectLedgerEntry>()
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      // まだ無い（初めて）・読めない。空から数える（想定内）
      return map
    }
    if (text.length > MAX_FILE_BYTES) return map
    try {
      const raw = JSON.parse(text) as { projects?: Record<string, Partial<ProjectLedgerEntry>> }
      for (const [id, e] of Object.entries(raw.projects ?? {}).slice(0, MAX_PROJECTS)) {
        if (!id || id.length > 200 || typeof e?.day !== 'string' || e.day.length > 16) continue
        map.set(id, { day: e.day, calls: num(e.calls), usd: num(e.usd), maxCallTokens: num(e.maxCallTokens), maxCallUsd: num(e.maxCallUsd) })
      }
    } catch {
      // 壊れたファイル。空から数える（想定内。次の書き込みで直る）
    }
    return map
  }

  save(entries: Map<string, ProjectLedgerEntry>): void {
    const projects = Object.fromEntries([...entries].slice(-MAX_PROJECTS))
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, projects })}\n`, { flag: 'wx', mode: 0o600 })
    try {
      renameSync(tmp, this.file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }
}
