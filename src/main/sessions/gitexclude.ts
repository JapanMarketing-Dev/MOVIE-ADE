/**
 * `.ade-movie/` をgit管理対象外にする（要件 NF-9）。
 *
 * **`.gitignore` は変更しない**（利用者のリポジトリに差分を作らないため）。
 * 代わりに `.git/info/exclude` へ追記する。これはコミットされないローカル専用の除外設定。
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { ADE_DIR } from './paths'

const ENTRY = `${ADE_DIR}/`
const HEADER = '# MOVIE-ADE が追記（録画と分解結果をgit管理対象外にする）'

export type GitExcludeResult = 'added' | 'already' | 'no-git'

/**
 * `.git/info/exclude` に `.ade-movie/` を追記する。
 * 既に書かれていれば何もしない。gitリポジトリでなければ `no-git` を返す（エラーにしない）。
 */
export async function ensureGitExclude(projectDir: string): Promise<GitExcludeResult> {
  const gitDir = await resolveGitDir(projectDir)
  if (!gitDir) return 'no-git'

  const infoDir = join(gitDir, 'info')
  const excludePath = join(infoDir, 'exclude')

  // exclude がまだ無い（想定内。作る）
  const current = await readFile(excludePath, 'utf8').catch(() => null)
  if (current !== null && hasEntry(current)) return 'already'

  await mkdir(infoDir, { recursive: true })
  const needsNewline = current !== null && current.length > 0 && !current.endsWith('\n')
  await appendFile(excludePath, `${needsNewline ? '\n' : ''}${HEADER}\n${ENTRY}\n`, 'utf8')
  return 'added'
}

function hasEntry(text: string): boolean {
  return text
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === ENTRY || l === ADE_DIR || l === `/${ENTRY}` || l === `/${ADE_DIR}`)
}

/**
 * `.git` の実体を探す。
 * 通常はフォルダだが、worktree や submodule では `gitdir: <path>` と書かれたファイルになる。
 */
export async function resolveGitDir(projectDir: string): Promise<string | null> {
  const dotGit = join(projectDir, '.git')
  // Git で管理していないフォルダ（想定内）
  const s = await stat(dotGit).catch(() => null)
  if (!s) return null
  if (s.isDirectory()) return dotGit
  if (!s.isFile()) return null

  // 読めない .git ファイルは Git の外として扱う（想定内）
  const text = await readFile(dotGit, 'utf8').catch(() => '')
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) return null
  const target = m[1]!.trim()
  return isAbsolute(target) ? target : resolve(projectDir, target)
}
