/**
 * ファイルツリーの git の色分け（VS Code のエクスプローラーと同じ考え）。main の fs:gitStatus と renderer で共有する純粋関数。
 *
 * - main は `git status --porcelain=v1 -z --untracked-files=normal --ignored=matching -- .` を走らせ、
 *   parseGitStatusZ でプロジェクトからの相対パスと状態の組にして送る（src/main/gitDecorations.ts）
 * - renderer は buildGitDecorations で、変更を含むフォルダへ状態を伝える（親へ伝播）
 * - .gitignore の対象は薄く出す。.DS_Store・.git は既定で隠す（isHiddenByDefault）
 */

/** 1つのパスの git の状態。並びは強い順（フォルダには、中で一番強いものを付ける） */
export type GitFileState = 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'added' | 'untracked' | 'ignored'

/** fs:gitStatus の結果 */
export interface FsGitStatus {
  /** git のリポジトリの中か（git が無い・リポジトリでないときは false で、何も色を付けない） */
  isGit: boolean
  /** プロジェクトからの相対パス（`/` 区切り。フォルダの末尾の `/` は外す）と状態 */
  entries: Array<[path: string, state: GitFileState]>
  /** 出力が多すぎて途中で打ち切った */
  truncated: boolean
}

/** 右端に出す文字（VS Code と同じ。フォルダは文字の代わりに点を出す） */
export const GIT_STATE_LETTER: Record<Exclude<GitFileState, 'ignored'>, string> = {
  conflicted: '!',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  added: 'A',
  untracked: 'U'
}

const RANK: Record<GitFileState, number> = { conflicted: 6, deleted: 5, modified: 4, renamed: 3, added: 2, untracked: 1, ignored: 0 }

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** porcelain v1 の2文字の状態（XY）を1つの状態にする。分からないものは null */
export function stateFromXY(xy: string): GitFileState | null {
  if (xy === '??') return 'untracked'
  if (xy === '!!') return 'ignored'
  if (CONFLICT_CODES.has(xy)) return 'conflicted'
  const [x = ' ', y = ' '] = xy
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  if (x === 'R' || x === 'C') return 'renamed'
  if (x === 'M' || y === 'M' || x === 'T' || y === 'T') return 'modified'
  return null
}

/**
 * `git status --porcelain=v1 -z` の出力を、プロジェクトからの相対パスと状態の組にする。
 * パスはリポジトリの根からなので、プロジェクトがリポジトリの下のフォルダなら prefix（`git rev-parse --show-prefix`。`sub/dir/`）を外し、
 * 外のものは捨てる。途中で切れた最後の項目は読まない（打ち切ったときも、出来上がった分だけ使う）。
 */
export function parseGitStatusZ(stdout: string, prefix = ''): Array<[string, GitFileState]> {
  const records = stdout.split('\0')
  // 最後は NUL の後ろの残り（完全な出力なら空、打ち切ったなら途中の項目）
  records.pop()
  const out: Array<[string, GitFileState]> = []
  const base = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record.length < 4 || record[2] !== ' ') continue
    const xy = record.slice(0, 2)
    // 名前の変更・コピーは、次の項目に元の名前が続く（使わない）
    if (xy[0] === 'R' || xy[0] === 'C') i++
    const state = stateFromXY(xy)
    if (!state) continue
    let path = record.slice(3)
    if (base) {
      if (!path.startsWith(base)) continue
      path = path.slice(base.length)
    }
    if (path.endsWith('/')) path = path.slice(0, -1)
    // プロジェクトそのもの（`./`）は付ける先が無い
    if (path === '' || path === '.') continue
    out.push([path, state])
  }
  return out
}

/** renderer が引くための形 */
export interface GitDecorations {
  isGit: boolean
  /** そのパスそのものの状態（ファイル・追跡外のフォルダ・無視されたもの） */
  own: ReadonlyMap<string, GitFileState>
  /** 中に変更があるフォルダ（親へ伝えた一番強い状態。ignored は伝えない） */
  folders: ReadonlyMap<string, GitFileState>
}

export const EMPTY_GIT_DECORATIONS: GitDecorations = { isGit: false, own: new Map(), folders: new Map() }

function stronger(a: GitFileState | undefined, b: GitFileState): GitFileState {
  return a !== undefined && RANK[a] >= RANK[b] ? a : b
}

/** 状態の一覧から、パスごとの状態と、変更を含むフォルダ（親へ伝播）を作る */
export function buildGitDecorations(status: FsGitStatus | null): GitDecorations {
  if (!status || !status.isGit) return EMPTY_GIT_DECORATIONS
  const own = new Map<string, GitFileState>()
  const folders = new Map<string, GitFileState>()
  for (const [path, state] of status.entries) {
    own.set(path, stronger(own.get(path), state))
    if (state === 'ignored') continue
    let slash = path.lastIndexOf('/')
    while (slash > 0) {
      const dir = path.slice(0, slash)
      folders.set(dir, stronger(folders.get(dir), state))
      slash = dir.lastIndexOf('/')
    }
  }
  return { isGit: true, own, folders }
}

/** .gitignore の対象か（そのものか、上のフォルダが無視されている） */
export function isGitIgnored(deco: GitDecorations, path: string): boolean {
  if (!deco.isGit) return false
  let at = path
  for (;;) {
    if (deco.own.get(at) === 'ignored') return true
    const slash = at.lastIndexOf('/')
    if (slash <= 0) return false
    at = at.slice(0, slash)
  }
}

/** 追跡外のフォルダの中か（git は追跡外のフォルダを `dir/` の1行で返す） */
function insideUntracked(deco: GitDecorations, path: string): boolean {
  let slash = path.lastIndexOf('/')
  while (slash > 0) {
    const dir = path.slice(0, slash)
    if (deco.own.get(dir) === 'untracked') return true
    slash = dir.lastIndexOf('/')
  }
  return false
}

/** ツリーの1行に付ける状態。無視されたものは 'ignored'、フォルダは中の変更を伝えたもの、追跡外のフォルダの中は untracked */
export function gitStateFor(deco: GitDecorations, path: string, kind: 'file' | 'directory'): GitFileState | null {
  if (!deco.isGit) return null
  if (isGitIgnored(deco, path)) return 'ignored'
  const own = deco.own.get(path) ?? (kind === 'directory' ? deco.folders.get(path) : undefined)
  if (own) return own
  return insideUntracked(deco, path) ? 'untracked' : null
}

// ─── 既定で隠すもの ─────────────────────────────

/** どこにあっても既定で隠す名前 */
const ALWAYS_HIDDEN: ReadonlySet<string> = new Set(['.git', '.DS_Store'])

/**
 * 既定でツリーに出さないか。.git・.DS_Store だけ。
 * .env などは .gitignore の対象でも出す（以前は秘密を含みうるとして隠していたが、編集したいファイルが見えないので 2026-10-07 にやめた。
 * .gitignore の対象は gitStateFor の 'ignored' で薄く出る）
 */
export function isHiddenByDefault(entry: { name: string; path: string }): boolean {
  return ALWAYS_HIDDEN.has(entry.name)
}

/**
 * ツリーの行から隠すものを外す。隠したフォルダの中の行（開いていたとき）も一緒に外す。
 * rows はフォルダの直後にその中身が続く並び（fileTree.tsx の rows）。
 */
export function withoutHidden<T extends { entry: { name: string; path: string } }>(rows: readonly T[], hidden: (entry: T['entry']) => boolean): T[] {
  const out: T[] = []
  let skipUnder: string | null = null
  for (const row of rows) {
    if (skipUnder !== null && row.entry.path.startsWith(skipUnder)) continue
    skipUnder = null
    if (hidden(row.entry)) { skipUnder = `${row.entry.path}/`; continue }
    out.push(row)
  }
  return out
}
