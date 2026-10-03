/**
 * 動画の保持期間（要件 NF-8）。
 * 既定7日で `recording.webm` を自動削除する。**`feedback.md` と画像は残す。**
 * 中間ファイル（work/）も一緒に片付ける。
 */
import { lstat } from 'node:fs/promises'
import { removeContained, UnsafeStoragePathError } from './containment'
import { listSessionIds, sessionPaths, takePaths } from './paths'
import { loadSession } from './store'

export const DEFAULT_KEEP_DAYS = 7

export interface PruneOptions {
  /** 保持日数。0 以下なら削除しない（無期限保持） */
  keepDays?: number
  /** 基準時刻（テスト用） */
  now?: Date
  /** 本当には消さず、消す対象だけ返す */
  dryRun?: boolean
}

export interface PruneResult {
  /** 削除した（または削除対象の）動画 */
  removedRecordings: string[]
  /** 削除した中間ファイルのフォルダ */
  removedWork: string[]
  freedBytes: number
}

/**
 * 保持期間を過ぎた動画と中間ファイルを消す。
 * 判定は動画ファイルの更新時刻で行う（セッションIDの日時ではなく、実体の時刻を見る）。
 */
export async function pruneRecordings(
  projectDir: string,
  options: PruneOptions = {}
): Promise<PruneResult> {
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS
  const result: PruneResult = { removedRecordings: [], removedWork: [], freedBytes: 0 }
  if (keepDays <= 0) return result

  const now = (options.now ?? new Date()).getTime()
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000

  // .ferret/ と改名前の .ade-movie/ の両方（まだ録画していないプロジェクトにはフォルダが無い。想定内）
  const names = await listSessionIds(projectDir)
  for (const name of names) {
    // リンクで外へ向くレビュー・録画のフォルダ（containment.ts が断る）は掃除しない。ほかのレビューの掃除は続ける
    try { await pruneSession(projectDir, name, cutoff, options, result) } catch (err) { if (!(err instanceof UnsafeStoragePathError)) throw err }
  }
  return result
}

async function pruneSession(projectDir: string, name: string, cutoff: number, options: PruneOptions, result: PruneResult): Promise<void> {
  const review = sessionPaths(projectDir, name)
  const record = await loadSession(review)
  if (!record) return // 未処理の素材は、復元するまで削除しない

  // 追記した録画（takes/<n>/）も同じ期間で片付ける。足し終えていない録画は残す
  for (const paths of [review, ...(record.takes ?? []).filter((take) => Number.isInteger(take?.n) && take.n >= 2).map((take) => takePaths(review, take.n))]) {
    // 録画の無い・消し済みのレビュー（想定内）
    const video = await lstat(paths.recording).catch(() => null)
    if (video?.isFile() && video.mtimeMs < cutoff) {
      result.removedRecordings.push(paths.recording)
      result.freedBytes += video.size
      if (!options.dryRun) await removeContained(projectDir, paths.recording)
    }
    // 削った版も同じ期間で消す（元の動画より新しいので、元と一緒に判定する）
    const trimmed = await lstat(paths.trimmedRecording).catch(() => null)
    if (trimmed?.isFile() && video && video.mtimeMs < cutoff) {
      result.removedRecordings.push(paths.trimmedRecording)
      result.freedBytes += trimmed.size
      if (!options.dryRun) await removeContained(projectDir, paths.trimmedRecording)
    }

    // 中間ファイルは分解が終われば不要。期間を過ぎたものは消す
    // 中間ファイルの無いレビュー（想定内）
    const work = await lstat(paths.workDir).catch(() => null)
    if (work?.isDirectory() && work.mtimeMs < cutoff) {
      result.removedWork.push(paths.workDir)
      if (!options.dryRun) await removeContained(projectDir, paths.workDir, { recursive: true })
    }
  }
}
