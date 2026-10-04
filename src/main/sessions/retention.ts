/**
 * 動画の保持期間（要件 NF-8）。
 * 既定7日で `recording.webm` を自動削除する。**`feedback.md` と画像は残す。**
 * 中間ファイル（work/）も一緒に片付ける。
 *
 * 起動時の掃除は窓を開くのを待たせない（security-5 [7]）。scheduleRetention が小さな切れ（RETENTION_LIMITS）に分け、
 * 1切れで見るレビューの数・読む session.json の大きさ・消す数・時間に上限を置き、あいだに間を空けて続きから進める。
 */
import { lstat } from 'node:fs/promises'
import { removeContained, UnsafeStoragePathError } from './containment'
import { RETENTION_LIMITS, SESSION_LIMITS } from './limits'
import { listSessionIds, sessionPaths, takePaths } from './paths'
import { loadSession } from './store'

const DEFAULT_KEEP_DAYS = 7

type RetentionLimits = { [K in keyof typeof RETENTION_LIMITS]: number }

interface PruneOptions {
  /** 保持日数。0 以下なら削除しない（無期限保持） */
  keepDays?: number
  /** 基準時刻（テスト用） */
  now?: Date
  /** 本当には消さず、消す対象だけ返す */
  dryRun?: boolean
  /** 見るセッションID（新しい順）。省略時は一覧を読む */
  ids?: string[]
  /** ids のどこから見るか（前の切れの next） */
  startAt?: number
  /** 1切れの上限（テスト用に小さくする）。省略時は RETENTION_LIMITS */
  limits?: Partial<RetentionLimits>
  /** 経過時間を測る時計(ms)。テスト用 */
  clock?: () => number
}

interface PruneResult {
  /** 削除した（または削除対象の）動画 */
  removedRecordings: string[]
  /** 削除した中間ファイルのフォルダ */
  removedWork: string[]
  freedBytes: number
  /** この切れで見たレビューの数・読んだ session.json の大きさ・消した数 */
  scanned: number
  readBytes: number
  deletes: number
  /** 続きがあれば、次の切れの startAt。最後まで見たら null */
  next: number | null
  /** 見たセッションID（続きの切れに渡す） */
  ids: string[]
}

/** 1切れで使った量 */
interface SliceWork {
  limits: RetentionLimits
  deletes: number
}

/**
 * 保持期間を過ぎた動画と中間ファイルを消す（1切れ分）。
 * 判定は動画ファイルの更新時刻で行う（セッションIDの日時ではなく、実体の時刻を見る）。
 * 上限に届いたら、そこで止めて next を返す（scheduleRetention が間を空けて続きを呼ぶ）
 */
export async function pruneRecordings(
  projectDir: string,
  options: PruneOptions = {}
): Promise<PruneResult> {
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS
  const result: PruneResult = { removedRecordings: [], removedWork: [], freedBytes: 0, scanned: 0, readBytes: 0, deletes: 0, next: null, ids: [] }
  if (keepDays <= 0) return result

  const now = (options.now ?? new Date()).getTime()
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000
  const limits: RetentionLimits = { ...RETENTION_LIMITS, ...options.limits }
  const clock = options.clock ?? (() => performance.now())
  const started = clock()

  // .ferret/ と改名前の .ade-movie/ の両方（まだ録画していないプロジェクトにはフォルダが無い。想定内）。一覧そのものも名前の数に上限がある（paths.ts）
  const ids = options.ids ?? await listSessionIds(projectDir)
  result.ids = ids
  const work: SliceWork = { limits, deletes: 0 }
  let i = options.startAt ?? 0
  for (; i < ids.length; i++) {
    if (result.scanned >= limits.sessionsPerSlice || work.deletes >= limits.deletesPerSlice || clock() - started >= limits.sliceMs) break
    let review
    try { review = sessionPaths(projectDir, ids[i]) } catch (err) { if (err instanceof UnsafeStoragePathError) continue; throw err }
    // 読む前に大きさを見て、この切れの読む量に収まらなければ次の切れへ回す（1つは上限 sessionJsonBytes まで）
    const size = Math.min((await lstat(review.sessionJson).catch(() => null))?.size ?? 0, SESSION_LIMITS.sessionJsonBytes)
    if (result.scanned > 0 && result.readBytes + size > limits.readBytesPerSlice) break
    result.scanned++
    result.readBytes += size
    // リンクで外へ向くレビュー・録画のフォルダ（containment.ts が断る）は掃除しない。ほかのレビューの掃除は続ける
    let finished = true
    try { finished = await pruneSession(projectDir, review, cutoff, options, result, work) } catch (err) { if (!(err instanceof UnsafeStoragePathError)) throw err }
    // 消す数の上限で途中までしか見ていなければ、同じレビューを次の切れで見直す（消したものはもう無いので数えない）。
    // dryRun では消えないので見直さない（同じところを繰り返さない）
    if (!finished && !options.dryRun) break
  }
  result.deletes = work.deletes
  result.next = i < ids.length ? i : null
  return result
}

/** @returns 最後まで見たら true。消す数の上限で途中でやめたら false */
async function pruneSession(projectDir: string, review: ReturnType<typeof sessionPaths>, cutoff: number, options: PruneOptions, result: PruneResult, work: SliceWork): Promise<boolean> {
  const record = await loadSession(review)
  if (!record) return true // 未処理の素材は、復元するまで削除しない
  const remove = async (target: string, recursive = false) => {
    work.deletes++
    if (!options.dryRun) await removeContained(projectDir, target, { recursive })
  }

  // 追記した録画（takes/<n>/）も同じ期間で片付ける。足し終えていない録画は残す
  for (const paths of [review, ...(record.takes ?? []).filter((take) => Number.isInteger(take?.n) && take.n >= 2).map((take) => takePaths(review, take.n))]) {
    if (work.deletes >= work.limits.deletesPerSlice) return false
    // 録画の無い・消し済みのレビュー（想定内）
    const video = await lstat(paths.recording).catch(() => null)
    if (video?.isFile() && video.mtimeMs < cutoff) {
      result.removedRecordings.push(paths.recording)
      result.freedBytes += video.size
      await remove(paths.recording)
    }
    // 削った版も同じ期間で消す（元の動画より新しいので、元と一緒に判定する）
    const trimmed = await lstat(paths.trimmedRecording).catch(() => null)
    if (trimmed?.isFile() && video && video.mtimeMs < cutoff) {
      result.removedRecordings.push(paths.trimmedRecording)
      result.freedBytes += trimmed.size
      await remove(paths.trimmedRecording)
    }

    // 中間ファイルは分解が終われば不要。期間を過ぎたものは消す
    // 中間ファイルの無いレビュー（想定内）
    const workDir = await lstat(paths.workDir).catch(() => null)
    if (workDir?.isDirectory() && workDir.mtimeMs < cutoff) {
      result.removedWork.push(paths.workDir)
      await remove(paths.workDir, true)
    }
  }
  return true
}

export interface RetentionRun {
  /** 残りの切れをやめる（プロジェクトを閉じる・アプリの終了） */
  cancel(): void
  /** 最後の切れまで終わったら、合計で resolve する（やめたらそこまでの合計） */
  done: Promise<Pick<PruneResult, 'removedRecordings' | 'removedWork' | 'freedBytes' | 'scanned'>>
}

/**
 * 起動時の掃除を、窓を開くのを待たせずに切れに分けて進める（security-5 [7]）。
 * 最初の切れは startDelayMs のあと、続きは idleMs ずつ空けて呼ぶ。失敗したら onError に渡してやめる
 */
export function scheduleRetention(projectDir: string, options: Omit<PruneOptions, 'ids' | 'startAt'> & { onError?: (err: unknown) => void; setTimer?: (fn: () => void, ms: number) => unknown } = {}): RetentionRun {
  const limits: RetentionLimits = { ...RETENTION_LIMITS, ...options.limits }
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref())
  const total = { removedRecordings: [] as string[], removedWork: [] as string[], freedBytes: 0, scanned: 0 }
  let cancelled = false
  let finish: (value: typeof total) => void = () => undefined
  const done = new Promise<typeof total>((resolve) => { finish = resolve })
  const slice = async (ids: string[] | undefined, startAt: number) => {
    if (cancelled) return finish(total)
    try {
      const r = await pruneRecordings(projectDir, { ...options, ...(ids ? { ids } : {}), startAt })
      total.removedRecordings.push(...r.removedRecordings)
      total.removedWork.push(...r.removedWork)
      total.freedBytes += r.freedBytes
      total.scanned += r.scanned
      if (r.next === null || cancelled) return finish(total)
      const next = r.next
      setTimer(() => void slice(r.ids, next), limits.idleMs)
    } catch (err) {
      options.onError?.(err)
      finish(total)
    }
  }
  setTimer(() => void slice(undefined, 0), limits.startDelayMs)
  return { cancel: () => { cancelled = true }, done }
}
