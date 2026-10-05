import { randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  RESTORE_FILE_MAX_BYTES,
  claudeProjectDirName,
  emptyRestoreFile,
  parseRestoreFile,
  planSessionRestore,
  popClosedTerminal,
  pushClosedTerminal,
  sanitizeClosedTerminal,
  sanitizeRestoreSnapshot,
  serializeRestoreFile,
  type ClosedTerminal,
  type TerminalRestoreFile,
  type TerminalRestoreSnapshot
} from '@shared/terminalRestore'
import { readTextBoundedSync } from './boundedFile'
import { reportHandled } from '@shared/report'

/**
 * ターミナルのタブと画面の文字を userData/terminal-restore.json に書いておく（@shared/terminalRestore）。
 *
 * - renderer がときどき（タブが変わったとき・出力があったとき）今のタブと画面の文字を送り、ここでは確かめてから覚える。
 *   ファイルへは少しまとめてから書き、終了のときは最後にもう一度 renderer に頼んでから同期で書く（index.ts）
 * - 閉じたタブは CLOSED_STACK_LIMIT 枚まで覚え、開き直すときに新しいものから渡す
 * - 書くのはプロジェクトの外（userData）だけ。所有者だけが読める 0600 で、一時ファイルを O_EXCL・O_NOFOLLOW で作ってから
 *   rename で置き換える（途中で落ちても前のファイルか新しいファイルのどちらかが残り、置いてあったリンクの先には書かない）
 * - 読むときも上限つき・リンクをたどらない（boundedFile.ts）。中身は制御文字を落として形を確かめてから使う
 * - 設定（agents.restoreTerminals）が切なら何も覚えず、書いたファイルも消す
 */

/** 書くのを待つ時間。出力が続いている間も、この間隔より多くは書かない */
const WRITE_DELAY_MS = 5000

export class TerminalRestoreStore {
  private data: TerminalRestoreFile = emptyRestoreFile()
  private loaded = false
  private sessionTaken = false
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  /** 終了のときに書き終えた。以後に届いたもの（PTY の終了で変わった画面など）は覚えない */
  private finished = false

  constructor(
    private readonly file: string,
    private readonly enabled: () => boolean
  ) {}

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.enabled()) return
    try {
      this.data = parseRestoreFile(readTextBoundedSync(this.file, RESTORE_FILE_MAX_BYTES, { noFollow: true }))
    } catch (err) {
      // 初めての起動（ファイルが無い）は想定内。それ以外（大きすぎる・リンク）は読まずに空から始める
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') reportHandled(err, { area: 'terminal', op: 'read terminal restore' })
      this.data = emptyRestoreFile()
    }
  }

  /**
   * 起動して最初の1回だけ、前に終了したときのタブを返す（画面を読み込み直したときに、もう一度作らない）。
   * 登録を外したプロジェクトのタブは返さない
   */
  takeSession(projectIds: ReadonlySet<string>): TerminalRestoreSnapshot | null {
    if (this.sessionTaken || !this.enabled()) return null
    this.sessionTaken = true
    this.ensureLoaded()
    return planSessionRestore(this.data.session, projectIds)
  }

  /** renderer から届いた、今開いているタブと画面の文字 */
  save(snapshot: unknown): void {
    if (this.finished || !this.enabled()) return
    const session = sanitizeRestoreSnapshot(snapshot)
    if (!session) return
    this.ensureLoaded()
    this.sessionTaken = true
    this.data = { ...this.data, session }
    this.schedule()
  }

  /** 利用者が閉じたタブを覚える */
  pushClosed(entry: unknown): void {
    if (this.finished || !this.enabled()) return
    const closed = sanitizeClosedTerminal(entry)
    if (!closed) return
    this.ensureLoaded()
    this.data = { ...this.data, closed: pushClosedTerminal(this.data.closed, closed) }
    this.schedule()
  }

  /** そのプロジェクトで最後に閉じたタブを取り出す。無ければ null */
  popClosed(projectId: string | null): ClosedTerminal | null {
    if (this.finished || !this.enabled()) return null
    this.ensureLoaded()
    const { entry, rest } = popClosedTerminal(this.data.closed, projectId)
    if (!entry) return null
    this.data = { ...this.data, closed: rest }
    this.schedule()
    return entry
  }

  /** 覚えたものをすべて消す（設定の「保存した履歴を消す」・設定を切にしたとき） */
  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirty = false
    this.loaded = true
    this.data = emptyRestoreFile()
    try {
      rmSync(this.file, { force: true })
    } catch (err) {
      reportHandled(err, { area: 'terminal', op: 'delete terminal restore' })
    }
  }

  /** 終了のとき。まだ書いていない変更を書き、以後は覚えない */
  finish(): void {
    this.flushSync()
    this.finished = true
  }

  /** まだ書いていない変更を、すぐに書く */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty) return
    this.dirty = false
    if (!this.enabled()) {
      this.clear()
      return
    }
    try {
      writePrivateFileAtomicSync(this.file, serializeRestoreFile(this.data))
    } catch (err) {
      reportHandled(err, { area: 'terminal', op: 'write terminal restore' })
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushSync()
    }, WRITE_DELAY_MS)
    this.timer.unref?.()
  }
}

/**
 * 所有者だけが読めるファイルを置き換える。一時ファイルは新しく作ったものだけに書き（O_EXCL）、リンクはたどらない（O_NOFOLLOW）。
 * rename は置き場所のリンクそのものを置き換えるので、リンクの先には書かない
 */
export function writePrivateFileAtomicSync(target: string, text: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  try {
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * そのフォルダに Claude Code の会話があるか（--continue で続けられるか）。無いのに --continue で起動すると
 * 「続ける会話が無い」で終わってしまうので、そのときは普通に起動する。
 * 会話は <設定フォルダ>/projects/<フォルダのパスの英数字以外を - にした名前>/*.jsonl にある（Claude Code 2.1.289 で確認）
 */
export function hasClaudeConversation(cwd: string, configDir?: string): boolean {
  const base = configDir || join(homedir(), '.claude')
  const candidates = new Set([cwd])
  try {
    candidates.add(realpathSync(cwd))
  } catch {
    /* 消えたフォルダ（想定内。そのまま調べて、無ければ普通に起動する） */
  }
  for (const candidate of candidates) {
    try {
      if (readdirSync(join(base, 'projects', claudeProjectDirName(candidate))).some((name) => name.endsWith('.jsonl'))) return true
    } catch {
      /* 会話のフォルダが無い（想定内） */
    }
  }
  return false
}
