/**
 * 動画の保持期間（要件 NF-8）。
 * 既定7日で `recording.webm` を自動削除する。**`feedback.md` と画像は残す。**
 * 中間ファイル（work/）も一緒に片付ける。
 */
import { rm, stat } from 'node:fs/promises'
import { isSessionId, reviewsRoot, sessionPaths } from './paths'
import { loadSession } from './store'
import { readdir } from 'node:fs/promises'

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

  const names = await readdir(reviewsRoot(projectDir)).catch(() => [] as string[])
  for (const name of names) {
    if (!isSessionId(name)) continue
    const paths = sessionPaths(projectDir, name)
    if (!await loadSession(paths)) continue // 未処理の素材は、復元するまで削除しない

    const video = await stat(paths.recording).catch(() => null)
    if (video?.isFile() && video.mtimeMs < cutoff) {
      result.removedRecordings.push(paths.recording)
      result.freedBytes += video.size
      if (!options.dryRun) await rm(paths.recording, { force: true })
    }

    // 中間ファイルは分解が終われば不要。期間を過ぎたものは消す
    const work = await stat(paths.workDir).catch(() => null)
    if (work?.isDirectory() && work.mtimeMs < cutoff) {
      result.removedWork.push(paths.workDir)
      if (!options.dryRun) await rm(paths.workDir, { recursive: true, force: true })
    }
  }
  return result
}
