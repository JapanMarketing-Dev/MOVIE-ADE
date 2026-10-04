import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { shouldIncludePath } from '@shared/files'

/**
 * Linux 用の、フォルダごとの変更の見張り。
 *
 * Linux の fs.watch(root, { recursive: true }) は Node が中のフォルダ（node_modules・.git も）を全部たどって
 * inotify を張る。大きなリポジトリでは起動が重く、上限（fs.inotify.max_user_watches）に当たると
 * ENOSPC で見張りが黙って止まり、Agent が書いた変更がエディタに届かなくなる。
 * ここでは変更通知の対象（shouldIncludePath）のフォルダにだけ、1つずつ張る。
 * 例外として、指摘の進み具合（.ferret/reviews/<id>/progress.json）を拾うため .ferret/reviews/<id> までは降りる。
 */

/** 張るフォルダの数の上限。超えた分は見張らない（上限に当たってほかのアプリの見張りまで止めないため） */
const MAX_WATCHED_DIRS = 8000

/** このフォルダ（`/` 区切りの相対パス。'' はプロジェクトの直下）に降りて見張るか */
export function shouldWatchDir(rel: string): boolean {
  if (rel === '' || shouldIncludePath(rel)) return true
  return /^\.(?:ferret|ade-movie)(?:\/reviews(?:\/[^/]+)?)?$/.test(rel)
}

type Listener = (event: string, filename: string) => void

export class LinuxTreeWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly errorListeners: Array<(err: unknown) => void> = []
  private closed = false
  private limitReported = false

  constructor(private readonly root: string, private readonly listener: Listener,
    /** 上限に当たって一部を見張れなかったとき（1回だけ） */
    private readonly onLimit?: (err: unknown) => void) {
    // 直下は同期で張る（作れなければ fs.watch と同じく投げる）
    this.addDir('', true)
    void this.addChildren('')
  }

  on(event: 'error', listener: (err: unknown) => void): this {
    if (event === 'error') this.errorListeners.push(listener)
    return this
  }

  /** fs.watch（FSWatcher）と同じ形でエラーを知らせる。プロジェクトの監視の張り直しのテストが、どの OS でも同じ手で止められるように */
  emit(event: 'error', err: unknown): boolean {
    if (event !== 'error') return false
    for (const listener of this.errorListeners) listener(err)
    return this.errorListeners.length > 0
  }

  close(): void {
    this.closed = true
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /** 見張っているフォルダの数（単体テスト用） */
  get size(): number {
    return this.watchers.size
  }

  private addDir(rel: string, rethrow = false): boolean {
    if (this.closed || this.watchers.has(rel)) return false
    if (this.watchers.size >= MAX_WATCHED_DIRS) {
      this.reportLimit(new Error(`more than ${MAX_WATCHED_DIRS} folders`))
      return false
    }
    let watcher: FSWatcher
    try {
      watcher = watch(rel ? join(this.root, rel) : this.root, (event, name) => {
        if (!name) return
        const child = rel ? `${rel}/${String(name)}` : String(name)
        this.listener(event, child)
        if (event === 'rename') void this.onRename(child)
      })
    } catch (err) {
      if (rethrow) throw err
      // ENOSPC（inotify の上限）・消えたフォルダ・読めないフォルダ。そこから下は見張らない
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') this.reportLimit(err)
      return false
    }
    watcher.on('error', (err) => {
      this.removeTree(rel)
      if (rel === '') for (const listener of this.errorListeners) listener(err)
    })
    this.watchers.set(rel, watcher)
    return true
  }

  private async addChildren(rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(rel ? join(this.root, rel) : this.root, { withFileTypes: true })
    } catch {
      return // 消えた・読めない（想定内）
    }
    for (const entry of entries) {
      if (this.closed) return
      if (!entry.isDirectory()) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (shouldWatchDir(child) && this.addDir(child)) await this.addChildren(child)
    }
  }

  /** フォルダが増えたら張り、消えたら外す */
  private async onRename(rel: string): Promise<void> {
    const isDir = await stat(join(this.root, rel)).then((s) => s.isDirectory(), () => false)
    if (this.closed) return
    if (!isDir) {
      this.removeTree(rel)
      return
    }
    if (shouldWatchDir(rel) && this.addDir(rel)) await this.addChildren(rel)
  }

  private removeTree(rel: string): void {
    for (const [key, watcher] of this.watchers) {
      if (key === rel || (rel !== '' && key.startsWith(`${rel}/`)) || rel === '') {
        watcher.close()
        this.watchers.delete(key)
      }
    }
  }

  private reportLimit(err: unknown): void {
    if (this.limitReported) return
    this.limitReported = true
    this.onLimit?.(err)
  }
}
