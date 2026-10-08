/**
 * フォルダの項目を上限まで読む。macOS・Linux は opendir で少しずつ読み（大きなフォルダでも全項目の配列を作らない）、
 * Windows は readdir でまとめて読む。
 *
 * Windows の配布版で、opendir の終わり（Node の AfterOpenDir → DirHandle の生成）の中でアプリごと落ちていた
 * （FERRET-1Q。Electron 44.5.1 / Node 24.21.0 の node_dir.cc の DirHandle::DirHandle でのアクセス違反。
 * 公式のシンボルで ferret.exe+0x3b6c607 を読んで確かめた）。readdir は DirHandle を作らない
 */
import { opendir, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'

export interface DirEntriesResult {
  entries: Dirent[]
  /** 上限で打ち切った */
  truncated: boolean
}

export async function readDirEntries(path: string, max: number, platform: NodeJS.Platform = process.platform): Promise<DirEntriesResult> {
  if (platform === 'win32') {
    const all = await readdir(path, { withFileTypes: true })
    return { entries: all.slice(0, max), truncated: all.length > max }
  }
  const dir = await opendir(path)
  const entries: Dirent[] = []
  let truncated = false
  // for await を抜けると opendir の Dir は閉じる（最後まで読んだときも閉じ済み）
  for await (const entry of dir) {
    if (entries.length >= max) {
      truncated = true
      break
    }
    entries.push(entry)
  }
  return { entries, truncated }
}
