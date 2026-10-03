import { spawn } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { open, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  MAX_LISTED_FILES,
  MAX_TEXT_FILE_SIZE,
  hasBinaryExtension,
  isBinaryBuffer,
  isCollapsedByDefault,
  shouldIncludePath,
  type FsChangedEvent,
  type FsEntry,
  type FsFileList,
  type FsReadResult,
  type FsSearchMode,
  type FsSearchResult,
  type FsWriteResult
} from '@shared/files'
import { rankQuickOpenFiles } from '@shared/quickOpen'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'

/**
 * ファイルエディタの読み書き（fs:list / fs:read / fs:write / fs:files / fs:search / fs:changed）。
 *
 * renderer から来るのはプロジェクトからの相対パスだけ。ここで必ず
 *   1. 文字の上で（`..` を解決して）プロジェクトの中か
 *   2. シンボリックリンクを辿った実体もプロジェクトの中か
 * を確かめてから触る。どちらかで外に出るなら断る。
 */

/** 外に出るパスを断るときの文言（画面にそのまま出る） */
/** 画面の言語で返す（呼んだ時点の言語） */
function outsideMessage(): string {
  return t('files.errors.outside')
}

/** ファイル名の検索で返す上限 */
const MAX_NAME_MATCHES = 500

/**
 * target が root の中（root 自身を含む）なら root からの相対パス（`/` 区切り）を返す。外なら null。
 * 文字の上だけで判定する純粋関数。
 */
export function relativeInside(root: string, target: string): string | null {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return ''
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

/** renderer から来た相対パスの形を確かめる。絶対パス・NUL・ドライブ指定は断る */
function assertRelativeInput(relPath: unknown): asserts relPath is string {
  if (typeof relPath !== 'string' || relPath.includes('\0') || isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(outsideMessage())
  }
}

/**
 * 相対パスをプロジェクトの中の絶対パスへ直す。外に出るなら例外。
 * allowMissing のときは、まだ無いファイル（新規作成）でも、存在する一番近い親で実体を確かめる。
 */
export async function resolveInside(root: string, relPath: unknown, options: { allowMissing?: boolean } = {}): Promise<string> {
  assertRelativeInput(relPath)
  const absolute = resolve(root, relPath)
  if (relativeInside(root, absolute) === null) throw new Error(outsideMessage())

  const realRoot = await realpath(root)
  let probe = absolute
  for (;;) {
    try {
      const real = await realpath(probe)
      if (relativeInside(realRoot, real) === null) throw new Error(outsideMessage())
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      if (!options.allowMissing) throw err
      const parent = dirname(probe)
      if (parent === probe) throw new Error(outsideMessage())
      probe = parent
    }
  }
  return absolute
}

function toRel(root: string, absolute: string): string {
  return relativeInside(root, absolute) ?? ''
}

// ─── 一覧 ─────────────────────────────────────────────

export async function listDirectory(root: string, relDir: string): Promise<FsEntry[]> {
  const dir = await resolveInside(root, relDir)
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries: FsEntry[] = []
  for (const dirent of dirents) {
    const absolute = join(dir, dirent.name)
    let kind: FsEntry['kind'] | null = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : null
    if (dirent.isSymbolicLink()) {
      // 外を指すリンクは一覧にも出さない（開けないものを見せない）
      try {
        await resolveInside(root, toRel(root, absolute))
        kind = (await stat(absolute)).isDirectory() ? 'directory' : 'file'
      } catch {
        // 外を指す・切れたリンク（想定内）
        kind = null
      }
    }
    if (!kind) continue
    entries.push({
      name: dirent.name,
      path: toRel(root, absolute),
      kind,
      ...(kind === 'directory' && isCollapsedByDefault(dirent.name) ? { collapsed: true } : {})
    })
  }
  // フォルダが先、名前は自然順（file2 < file10）
  return entries.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  )
}

// ─── 読み書き ─────────────────────────────────────────────

export async function readTextFile(root: string, relPath: string): Promise<FsReadResult> {
  const file = await resolveInside(root, relPath)
  const path = toRel(root, file)
  const info = await stat(file)
  if (info.isDirectory()) throw new UserFacingError(t('files.errors.folder'))
  if (hasBinaryExtension(path)) return { kind: 'binary', path, reason: t('files.errors.binary') }
  if (info.size > MAX_TEXT_FILE_SIZE) {
    return {
      kind: 'tooLarge',
      path,
      size: info.size,
      reason: t('files.errors.tooLarge', { size: (info.size / 1024 / 1024).toFixed(1), limit: MAX_TEXT_FILE_SIZE / 1024 / 1024 })
    }
  }
  const handle = await open(file, 'r')
  try {
    const buffer = await handle.readFile()
    if (isBinaryBuffer(buffer)) return { kind: 'binary', path, reason: t('files.errors.binary') }
    return { kind: 'text', path, content: buffer.toString('utf8'), mtimeMs: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

export async function writeTextFile(root: string, relPath: string, content: string): Promise<FsWriteResult> {
  if (typeof content !== 'string') throw new UserFacingError(t('files.errors.badContent'))
  const file = await resolveInside(root, relPath, { allowMissing: true })
  // 上書きで中身を差し替える（rename で置き換えるとリンクや権限が変わり、監視も途切れる）
  await writeFile(file, content, 'utf8')
  return { mtimeMs: (await stat(file)).mtimeMs }
}

// ─── rg ─────────────────────────────────────────────

/**
 * rg の場所。Finder から起動するとシェルの PATH を引き継がないので、よくある場所も見る。
 * 見つからなければ null（Node で歩く遅い経路に切り替える）。
 */
let rgPath: string | null | undefined
function findRg(): string | null {
  if (rgPath !== undefined) return rgPath
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  rgPath = dirs.filter((dir) => dir.length > 0).map((dir) => join(dir, name)).find((candidate) => existsSync(candidate)) ?? null
  return rgPath
}

/** 除外するディレクトリを rg のグロブにする */
const RG_EXCLUDES = ['.git', 'node_modules', '.ade-movie'].flatMap((dir) => ['--glob', `!**/${dir}/**`])

/**
 * rg を走らせ、1行ごとに onLine を呼ぶ。onLine が false を返したら打ち切る。
 * 戻り値は打ち切ったか。
 */
function runRg(rg: string, cwd: string, args: string[], onLine: (line: string) => boolean): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(rg, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    let buffer = ''
    let stopped = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line && !onLine(line)) {
          stopped = true
          child.kill()
          return
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.on('error', reject)
    child.on('close', () => {
      if (!stopped && buffer) onLine(buffer)
      resolvePromise(stopped)
    })
  })
}

// ─── ファイル一覧（クイックオープン）─────────────────────

/** rg が無いときの一覧。重いディレクトリは降りない */
async function walkFiles(root: string, limit: number): Promise<FsFileList> {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0) {
    const relDir = queue.shift()!
    let dirents
    try {
      dirents = await readdir(join(root, relDir), { withFileTypes: true })
    } catch {
      // 読めないフォルダ（権限など）は飛ばす（想定内）
      continue
    }
    for (const dirent of dirents) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (!isCollapsedByDefault(dirent.name)) queue.push(rel)
      } else if (dirent.isFile()) {
        files.push(rel)
        if (files.length >= limit) return { files, truncated: true }
      }
    }
  }
  return { files, truncated: false }
}

export async function listFiles(root: string): Promise<FsFileList> {
  const realRoot = await realpath(root)
  const rg = findRg()
  if (!rg) return walkFiles(realRoot, MAX_LISTED_FILES)
  const files: string[] = []
  // .gitignore に従う。隠しファイル（.env.example など）は出す
  const truncated = await runRg(rg, realRoot, ['--files', '--hidden', ...RG_EXCLUDES], (line) => {
    const rel = line.replace(/\\/g, '/').replace(/^\.\//, '')
    if (shouldIncludePath(rel)) files.push(rel)
    return files.length < MAX_LISTED_FILES
  }).catch((err: unknown) => { reportHandled(err, { area: 'files', op: 'list files with rg' }); return null })
  if (truncated === null) return walkFiles(realRoot, MAX_LISTED_FILES)
  return { files, truncated }
}

// ─── ファイル名の検索 ─────────────────────────────

export async function searchFiles(root: string, query: string, mode: FsSearchMode): Promise<FsSearchResult> {
  const realRoot = await realpath(root)
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (!trimmed) return { mode, files: [], truncated: false }
  const listing = await listFiles(realRoot)
  const ranked = rankQuickOpenFiles(trimmed, listing.files, MAX_NAME_MATCHES)
  return { mode, files: ranked.map((r) => r.path), truncated: listing.truncated || ranked.length >= MAX_NAME_MATCHES }
}

// ─── 外部の変更の監視 ─────────────────────────────────────

/** まとめて通知するまでの待ち。Agent が続けて何ファイルも書くときに1回へまとめる */
const CHANGE_BATCH_MS = 150

/**
 * プロジェクトフォルダの変更を見張り、相対パスをまとめて知らせる。
 * Orca は @parcel/watcher を使うが、依存（ネイティブモジュール）を増やさないため
 * Node の fs.watch(recursive) を使う（macOS / Windows は OS の仕組み、Linux も Node 20 以降で対応）。
 */
export class ProjectWatcher {
  private watcher: FSWatcher | null = null
  private pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (event: FsChangedEvent) => void) {}

  watch(root: string | null): void {
    this.close()
    if (!root) return
    try {
      this.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const rel = String(filename).split(sep).join('/')
        if (!shouldIncludePath(rel)) return
        this.pending.add(rel)
        this.timer ??= setTimeout(() => this.flush(), CHANGE_BATCH_MS)
      })
      // 監視できなくなっても（フォルダの削除など）アプリは止めない
      this.watcher.on('error', () => this.close())
    } catch (err) {
      console.warn('[files] フォルダの変更を見張れません', err)
      reportHandled(err, { area: 'files', op: 'watch project folder' })
      this.watcher = null
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private flush(): void {
    this.timer = null
    if (this.pending.size === 0) return
    const paths = [...this.pending]
    this.pending.clear()
    this.onChange({ paths })
  }
}
