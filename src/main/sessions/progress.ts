/**
 * 指摘ごとの進み具合（progress.json）の読み書き。形と読み方は @shared/findingProgress。
 *
 * Agent も同じファイルを書くので、Ferret は書く直前に読み直して重ねる（Agent の書いた分を消さない）。
 * 書き途中のファイルを Agent が読まないよう、別名に書いてから置き換える。
 * 変更は ProjectWatcher（files.ts）が fs:changed で知らせ、renderer が読み直す。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { applyProgress, parseProgress, serializeProgress, type ProgressMap, type ProgressPatchValue } from '@shared/findingProgress'
import type { SessionPaths } from './paths'

/** 読めなければ空（まだ誰も書いていない・壊れた JSON）。knownIds を渡すと知らないIDを落とす */
export async function readProgress(paths: SessionPaths, knownIds?: Iterable<string>): Promise<ProgressMap> {
  try {
    return parseProgress(JSON.parse(await readFile(paths.progressJson, 'utf8')), knownIds)
  } catch {
    // 送る前のレビューには progress.json が無い。Agent が書き損じた JSON も未対応として読む（想定内）
    return {}
  }
}

const queues = new Map<string, Promise<unknown>>()

/** 変更を重ねて書く。同じレビューへの書き込みは順番に行う */
export async function updateProgress(paths: SessionPaths, patch: Record<string, ProgressPatchValue>): Promise<ProgressMap> {
  // 前の書き込みの失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
  const next = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const merged = applyProgress(await readProgress(paths), patch)
    const tmp = `${paths.progressJson}.tmp`
    await writeFile(tmp, `${JSON.stringify(serializeProgress(merged), null, 2)}\n`, 'utf8')
    await rename(tmp, paths.progressJson)
    return merged
  })
  queues.set(paths.dir, next)
  try { return await next } finally { if (queues.get(paths.dir) === next) queues.delete(paths.dir) }
}
