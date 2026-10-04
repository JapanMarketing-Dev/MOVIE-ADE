/**
 * `.ferret/`（と改名前の `.ade-movie/`）をgit管理対象外にする（要件 NF-9）。
 *
 * **`.gitignore` は変更しない**（利用者のリポジトリに差分を作らないため）。
 * 代わりに `.git/info/exclude` へ追記する。これはコミットされないローカル専用の除外設定。
 *
 * `.git` の中身はプロジェクト側が決められる（取ってきた zip に細工した `.git` ファイルが入っていることもある）。
 * `gitdir:` の書く先をそのまま信じず、git 自身（rev-parse）に除外ファイルの場所を聞き、
 * その先祖にリンクが無く、普通のファイル（まだ無ければ新しく作る）であるときだけ書く。
 */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { readTextBounded } from '../boundedFile'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ADE_DIR, LEGACY_ADE_DIR } from './paths'
import { assertContained, mkdirContained, writeFileNoFollow } from './containment'

/** 除外するフォルダ。古いレビューが残る .ade-movie/ も外したままにする */
const DIRS = [ADE_DIR, LEGACY_ADE_DIR]
const HEADER = '# Ferret が追記（録画と分解結果をgit管理対象外にする）'

type GitExcludeResult = 'added' | 'already' | 'no-git'

/**
 * `.git/info/exclude` に `.ferret/` と `.ade-movie/` を追記する。
 * 両方とも書かれていれば何もしない。足りない方だけ足す。gitリポジトリでなければ `no-git` を返す（エラーにしない）。
 * 除外ファイルの場所を確かめられない（git が無い・細工された `.git`・リンク）ときも `no-git` で何も書かない
 */
export async function ensureGitExclude(projectDir: string): Promise<GitExcludeResult> {
  const target = await resolveExcludeFile(projectDir)
  if (!target) return 'no-git'
  const { excludePath, root } = target

  // 無ければ作る（想定内）。あるのに読めない（大きすぎる・普通のファイルでない）ときは、中身を消さないよう書かない
  let current: string | null
  try {
    current = await readTextBounded(excludePath, 1024 * 1024, { noFollow: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'no-git'
    current = null
  }
  const missing = DIRS.filter((dir) => current === null || !hasEntry(current, dir))
  if (missing.length === 0) return 'already'

  const infoDir = dirname(excludePath)
  await mkdirContained(infoDir, { root })
  // 作ったあと・書く直前にもう一度確かめる（あいだにリンクへ差し替えられていないか）
  assertContained(root, excludePath)
  const needsNewline = current !== null && current.length > 0 && !current.endsWith('\n')
  // 追記の代わりに、読んだ中身＋足す分で置き換える（末端のリンク・ハードリンクへ書き込まない）
  await writeFileNoFollow(excludePath, `${current ?? ''}${needsNewline ? '\n' : ''}${HEADER}\n${missing.map((dir) => `${dir}/\n`).join('')}`)
  return 'added'
}

function hasEntry(text: string, dir: string): boolean {
  return text
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === `${dir}/` || l === dir || l === `/${dir}/` || l === `/${dir}`)
}

/**
 * `.git` の実体を探す（名前の上だけ。書く先の確かめは resolveExcludeFile）。
 * 通常はフォルダだが、worktree や submodule では `gitdir: <path>` と書かれたファイルになる。
 * `.git` 自体がリンクなら null
 */
async function resolveGitDir(projectDir: string): Promise<string | null> {
  const dotGit = join(projectDir, '.git')
  // Git で管理していないフォルダ（想定内）
  const s = await lstat(dotGit).catch(() => null)
  if (!s) return null
  if (s.isDirectory()) return dotGit
  if (!s.isFile()) return null

  // 読めない .git ファイルは Git の外として扱う（想定内）
  const text = await readTextBounded(dotGit, 64 * 1024, { noFollow: true }).catch(() => '')
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) return null
  const target = m[1]!.trim()
  return isAbsolute(target) ? target : resolve(projectDir, target)
}

/** git にリポジトリの場所を聞く（このフォルダを作業ツリーとして）。git が無い・リポジトリでなければ null */
function gitRevParse(projectDir: string, args: string[]): Promise<string[] | null> {
  // 呼び出し元の GIT_DIR などに引きずられないよう、git の場所を変える環境変数は外す
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(key)))
  return new Promise((done) => {
    execFile('git', ['-C', projectDir, 'rev-parse', ...args], { env, timeout: 5000, windowsHide: true }, (err, stdout) => {
      done(err ? null : stdout.split(/\r?\n/).filter((line) => line.length > 0))
    })
  })
}

/**
 * 書いてよい除外ファイルと、その確かめの基準のフォルダ。
 * - `.git` が無い・リンク・`gitdir:` の無いファイルなら null
 * - git に聞いた作業ツリーの一番上がこのフォルダでなければ null（親のリポジトリや、別のリポジトリを指す `.git` に書かない）
 * - git に聞いた git のフォルダが `.git`（ファイルなら gitdir: の書く先）と一致しなければ null
 * - 除外ファイル（git の info/exclude）の先祖にリンクがあれば null
 */
async function resolveExcludeFile(projectDir: string): Promise<{ excludePath: string; root: string } | null> {
  const declared = await resolveGitDir(projectDir)
  if (!declared) return null
  const answer = await gitRevParse(projectDir, ['--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--git-path', 'info/exclude'])
  if (!answer || answer.length < 4) {
    // git が無い・まだ中身の無い .git でも、.git が（リンクでない）フォルダなら、プロジェクトの中だけで確かめて書く。
    // gitdir: の間接参照は git で確かめられないときは信じない
    if (declared !== join(projectDir, '.git')) return null
    return plainExclude(projectDir)
  }
  const [toplevel, gitDir, commonDirRaw, excludeRaw] = answer as [string, string, string, string]
  const { realpath } = await import('node:fs/promises')
  const real = (p: string) => realpath(p).catch(() => null)
  const [realProject, realTop, realGitDir, realDeclared] = await Promise.all([real(projectDir), real(toplevel), real(gitDir), real(declared)])
  if (!realProject || realTop !== realProject) return null
  if (!realGitDir || realGitDir !== realDeclared) return null
  // `.git` がファイル（gitdir:）なら、指す先の git のフォルダがこのフォルダを作業ツリーとして持っていること
  // （worktree は <gitdir>/gitdir、submodule は core.worktree が戻ってくる）。別のリポジトリの .git を指していれば書かない
  if (declared !== join(projectDir, '.git') && !await pointsBack(realGitDir, projectDir, realProject)) return null
  // rev-parse の相対パスは -C のフォルダからの相対
  const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(projectDir, commonDirRaw)
  const excludePath = isAbsolute(excludeRaw) ? excludeRaw : resolve(projectDir, excludeRaw)
  try {
    // 普通のリポジトリならプロジェクトの中、worktree なら元のリポジトリの git のフォルダの中で確かめる
    assertContained(commonDir, excludePath)
    const commonStat = await lstat(commonDir)
    if (commonStat.isSymbolicLink() || !commonStat.isDirectory()) return null
    if (declared === join(projectDir, '.git')) assertContained(projectDir, excludePath)
  } catch {
    return null
  }
  // 末端は普通のファイル（無ければこれから作る）で、ほかに名前（ハードリンク）が無いこと
  const leaf = await lstat(excludePath).catch(() => null)
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink > 1)) return null
  return { excludePath, root: commonDir }
}

/** git のフォルダ（worktree・submodule のもの）が、このプロジェクトを作業ツリーとして指し返しているか */
async function pointsBack(gitDir: string, projectDir: string, realProject: string): Promise<boolean> {
  const { realpath } = await import('node:fs/promises')
  const real = (p: string) => realpath(p).catch(() => null)
  // worktree: <gitdir>/gitdir に、このプロジェクトの .git ファイルの場所が書かれている（相対なら gitdir から）
  const backFile = join(gitDir, 'gitdir')
  const back = await lstat(backFile).catch(() => null)
  if (back?.isFile()) {
    const text = (await readTextBounded(backFile, 64 * 1024, { noFollow: true }).catch(() => '')).trim()
    if (text && await real(isAbsolute(text) ? text : resolve(gitDir, text)) === await real(join(projectDir, '.git'))) return true
  }
  // submodule: git のフォルダの core.worktree がこのプロジェクト（相対なら gitdir から）
  const worktree = await new Promise<string | null>((done) => {
    execFile('git', ['config', '--file', join(gitDir, 'config'), '--get', 'core.worktree'], { timeout: 5000, windowsHide: true }, (err, stdout) => done(err ? null : stdout.trim() || null))
  })
  return !!worktree && await real(isAbsolute(worktree) ? worktree : resolve(gitDir, worktree)) === realProject
}

/** プロジェクト直下の .git フォルダの info/exclude（先祖・末端にリンクが無いときだけ） */
async function plainExclude(projectDir: string): Promise<{ excludePath: string; root: string } | null> {
  const excludePath = join(projectDir, '.git', 'info', 'exclude')
  try { assertContained(projectDir, excludePath) } catch { return null }
  const leaf = await lstat(excludePath).catch(() => null)
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink > 1)) return null
  return { excludePath, root: projectDir }
}
