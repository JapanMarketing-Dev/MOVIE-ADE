/**
 * 異常終了後の復元（要件 NF-12 / 設計8章「異常終了時は次回起動時に、残っているデータから分解をやり直せる」）。
 *
 * 録画中は操作ログ・静止画・音声チャンクを逐次ディスクへ書いているので、
 * `session.json` が無くても素材が揃っていれば分解をやり直せる。
 */
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionPaths } from './paths'
import { listSessionIds, sessionPaths } from './paths'

interface RecoverableSession {
  paths: SessionPaths
  /** 操作ログの行数（0 なら復元してもほぼ空になる） */
  eventCount: number
  /** 残っている音声チャンク（work/audio/*.wav）。文字起こしをやり直せる */
  audioChunks: string[]
  /** 残っている静止画（work/frames/*） */
  frameCount: number
  hasRecording: boolean
  /** 復元する価値があるか（素材が何か残っている） */
  worthRecovering: boolean
  reason: string
}

/**
 * 分解が終わっていないセッションを探す。
 * `session.json` が無く、かつ素材が残っているものが対象。
 */
export async function findIncompleteSessions(projectDir: string): Promise<RecoverableSession[]> {
  // .ferret/ と改名前の .ade-movie/ の両方（まだ録画していないプロジェクトにはフォルダが無い。想定内）
  const names = await listSessionIds(projectDir)
  const out: RecoverableSession[] = []

  for (const name of names) {
    const paths = sessionPaths(projectDir, name)
    // 一覧のあとに消されたものは飛ばす（想定内）
    const dir = await stat(paths.dir).catch(() => null)
    if (!dir?.isDirectory()) continue
    // 分解が終わっているものは対象外
    if (existsSync(paths.sessionJson)) continue

    const info = await inspect(paths)
    if (info.worthRecovering) out.push(info)
  }
  return out.sort((a, b) => (a.paths.id < b.paths.id ? 1 : -1))
}

export async function inspect(paths: SessionPaths): Promise<RecoverableSession> {
  const eventCount = await countLines(paths.eventsJsonl)
  const audioChunks = (await listFiles(paths.audioDir))
    .filter((f) => f.endsWith('.wav'))
    .map((f) => join(paths.audioDir, f))
    .sort()
  const frameCount = (await listFiles(paths.framesDir)).length
  const hasRecording = existsSync(paths.recording)

  const worthRecovering = eventCount > 0 || audioChunks.length > 0 || frameCount > 0
  const reason = worthRecovering
    ? `操作ログ${eventCount}行 / 音声${audioChunks.length}区切り / 静止画${frameCount}枚が残っている`
    : '素材が残っていない'

  return { paths, eventCount, audioChunks, frameCount, hasRecording, worthRecovering, reason }
}

async function countLines(path: string): Promise<number> {
  // 無いファイルは0行（想定内）。大きさ・行数の上限付きで数え、リンクはたどらない（limits.ts）
  const { countJsonLines } = await import('./limits')
  return countJsonLines(path)
}

async function listFiles(dir: string): Promise<string[]> {
  // 無いフォルダは空（想定内）
  return readdir(dir).catch(() => [] as string[])
}
