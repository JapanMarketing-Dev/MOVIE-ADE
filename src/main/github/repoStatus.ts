import { watch, type FSWatcher } from 'node:fs'
import type { GitRepoStatus } from '@shared/github'
import { run } from './gh'
import { parseGitRemote, parseGitStatus } from './parse'

/**
 * フッターの「どの GitHub の、どのブランチか」。
 *
 * git を2回だけ呼ぶ（remote get-url と status --porcelain=v2 --branch）。status は optional locks を切って
 * 走らせるので、ターミナルで動いている git と index.lock を取り合わない。
 * 追跡外のファイルは `normal`（ディレクトリ単位）で数え、node_modules などの大きなフォルダを歩き回らない。
 */
export async function gitRepoStatus(folderPath: string | null): Promise<GitRepoStatus> {
  const empty: GitRepoStatus = { isGit: false, repo: null, branch: null, shortOid: null, changes: 0, ahead: 0, behind: 0, hasUpstream: false }
  if (!folderPath) return empty
  const [status, remote] = await Promise.all([
    run('git', ['-C', folderPath, '-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], { timeoutMs: 5_000 }),
    run('git', ['-C', folderPath, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 })
  ])
  if (status.failed) return empty
  return {
    isGit: true,
    repo: remote.failed ? null : parseGitRemote(remote.stdout),
    ...parseGitStatus(status.stdout)
  }
}

// ─── .git/HEAD の監視 ─────────────────────────────

let watched: { folder: string; watcher: FSWatcher | null } | null = null

/**
 * 開いているプロジェクトの .git を見張り、HEAD（ブランチの切り替え）と index（コミット・ステージ）が
 * 変わったら onChange を呼ぶ。続けて起きた変化はまとめて1回にする。
 * 呼ぶたびに対象のフォルダを確かめ、プロジェクトが変わっていれば見張り直す。
 */
export async function watchGitHead(folderPath: string | null, onChange: () => void): Promise<void> {
  if (watched?.folder === folderPath) return
  watched?.watcher?.close()
  watched = folderPath ? { folder: folderPath, watcher: null } : null
  if (!folderPath) return
  const current = watched
  // worktree では .git がファイルなので、git に本当の置き場を聞く
  const gitDir = await run('git', ['-C', folderPath, 'rev-parse', '--absolute-git-dir'], { timeoutMs: 5_000 })
  if (gitDir.failed || watched !== current) return
  let timer: NodeJS.Timeout | null = null
  try {
    current!.watcher = watch(gitDir.stdout.trim(), (_event, filename) => {
      if (filename !== 'HEAD' && filename !== 'index') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; onChange() }, 500)
    })
    current!.watcher.on('error', () => current!.watcher?.close())
  } catch {
    // 見張れなくても、定期の読み直しとウインドウを前に出したときの読み直しで追いつく
  }
}

export function stopWatchingGitHead(): void {
  watched?.watcher?.close()
  watched = null
}
