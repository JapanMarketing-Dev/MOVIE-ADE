/**
 * 裏の fetch（プロジェクトを開いたとき・定期・前に出したとき）を、利用者が認めたリモートにだけ行う（security-7 [9]）。
 *
 * リモートはプロジェクトの .git/config が決める。渡されたフォルダを開いただけで、知らない相手へ通信させないため、
 * 「このプロジェクトのこのリモートへ自動で確認してよい」を、フッターで行き先を見せて認めてもらってから走らせる。
 *   - 認めたものはプロジェクトの外（userData の JSON）に残す。プロジェクトの設定では増やせない
 *   - 行き先は認証情報を外した URL で覚える。リモートの URL が変われば、また聞く
 *   - Ferret で clone したプロジェクトは、利用者が URL を入れたので、そのリモートを認めたものとして始める
 *   - 利用者が押す「リモートの変更を確認」などは、そのたびの操作なので、これを見ない
 *
 * Electron に依存させない（単体テストで一時フォルダに書くため）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

const MAX_ENTRIES = 1000
const MAX_FILE_BYTES = 512 * 1024

export type FetchConsent = 'approved' | 'declined' | 'unknown'

/**
 * 認める単位のリモート。scp 形式（git@host:owner/repo）も URL にそろえ、認証情報・末尾の .git と / を外し、ホストを小文字にする。
 * 読めない形は null（自動の fetch はしない）
 */
export function canonicalRemote(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > 2048 || /[\s\0]/.test(text)) return null
  // Windows のドライブのパス（C:\… / C:/…）と \ を含むものはローカルのパス。scp 形式（host:path）と読み違えない
  if (/^[A-Za-z]:[\\/]/.test(text) || text.includes('\\')) return null
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(text)
  let url: URL
  try {
    url = scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? new URL(`ssh://${scp[1]}/${scp[2]}`) : new URL(text)
  } catch {
    return null
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${pathname}`
}

/** 画面に出す行き先（ホストとパス） */
export function remoteLabel(canonical: string): string {
  return canonical.replace(/^[a-z+]+:\/\//, '')
}

export class FetchConsentStore {
  private cache: Map<string, { remote: string; allowed: boolean }> | null = null

  constructor(private readonly file: string) {}

  private load(): Map<string, { remote: string; allowed: boolean }> {
    if (this.cache) return this.cache
    const map = new Map<string, { remote: string; allowed: boolean }>()
    try {
      const text = readFileSync(this.file, 'utf8')
      if (text.length <= MAX_FILE_BYTES) {
        const raw = JSON.parse(text) as { projects?: Record<string, { remote?: unknown; allowed?: unknown }> }
        for (const [folder, e] of Object.entries(raw.projects ?? {}).slice(0, MAX_ENTRIES)) {
          if (typeof e?.remote === 'string' && typeof e.allowed === 'boolean' && folder.length <= 4096) map.set(folder, { remote: e.remote, allowed: e.allowed })
        }
      }
    } catch {
      // まだ無い・壊れている。何も認めていないものとして始める（想定内）
    }
    this.cache = map
    return map
  }

  private save(map: Map<string, { remote: string; allowed: boolean }>): void {
    // 古いものから落とす（Map は入れた順）
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!)
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ projects: Object.fromEntries(map) }), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      rmSync(tmp, { force: true })
      // 書けなくても、この起動の間はメモリの値で動く（想定内）
    }
  }

  /** folder（実体のパス）の remote（canonicalRemote の値）を、自動で確認してよいか */
  consent(folder: string, remote: string): FetchConsent {
    const entry = this.load().get(folder)
    if (!entry || entry.remote !== remote) return 'unknown'
    return entry.allowed ? 'approved' : 'declined'
  }

  decide(folder: string, remote: string, allowed: boolean): void {
    const map = this.load()
    map.delete(folder)
    map.set(folder, { remote, allowed })
    this.save(map)
  }
}
