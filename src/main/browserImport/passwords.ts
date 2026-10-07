/**
 * ほかのブラウザから取り込んだパスワードの保管と、内蔵ブラウザのログインの欄への入力。
 *
 * - 取り込みの元は、利用者がブラウザの公式の機能で書き出した CSV だけ（src/shared/browserImport.ts の parsePasswordCsv）
 * - 保存は OS の鍵の仕組み（safeStorage）で暗号化した userData/browser-import/passwords.bin。
 *   暗号化できない環境・dev 起動・E2E では保存せず、その起動の間だけ持つ（文字起こしのキーと同じ。pipeline/stt/keys.ts の chooseKeyCipher）
 * - 復号は最初に要るとき（ページの照合・件数の表示）に1回だけ。以後はメモリに持つ
 * - renderer へはオリジンとユーザー名だけを返す。パスワードは、選んだ1件を main が内蔵ブラウザのページへ直接入れる
 *
 * **パスワード・ユーザー名をログ・エラーメッセージ・Sentry に出さないこと。**
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WebContents } from 'electron'
import { loginOrigin, originMatches, type ImportedLogin, type SavedLoginAccount } from '@shared/browserImport'
import type { KeyCipher } from '../pipeline/stt/keys'

interface StoredLogin extends ImportedLogin {
  id: string
}

/** 保存するファイルの形（暗号化する前の JSON） */
interface StoredFile {
  version: 1
  logins: StoredLogin[]
}

/** 復号した中身を確かめて読む。壊れた行は捨てる */
export function sanitizeStoredLogins(raw: unknown): StoredLogin[] {
  const list: unknown = (raw as Partial<StoredFile> | null)?.logins
  if (!Array.isArray(list)) return []
  return list.flatMap((item: unknown) => {
    const { id, origin, username, password } = (item ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || typeof origin !== 'string' || typeof username !== 'string' || typeof password !== 'string') return []
    if (!password || loginOrigin(origin) !== origin) return []
    return [{ id, origin, username, password }]
  })
}

/** 取り込んだ分を足す。同じオリジン＋ユーザー名は新しいパスワードで置き換える（id はそのまま） */
export function mergeLogins(existing: readonly StoredLogin[], incoming: readonly ImportedLogin[], newId: () => string = randomUUID): { logins: StoredLogin[]; added: number; updated: number } {
  const byKey = new Map(existing.map((login) => [`${login.origin}\n${login.username}`, login]))
  let added = 0
  let updated = 0
  for (const login of incoming) {
    const key = `${login.origin}\n${login.username}`
    const prev = byKey.get(key)
    if (prev) {
      if (prev.password !== login.password) updated++
      byKey.set(key, { ...prev, password: login.password })
    } else {
      added++
      byKey.set(key, { id: newId(), ...login })
    }
  }
  return { logins: [...byKey.values()], added, updated }
}

export class SavedLoginStore {
  private logins: StoredLogin[] | null = null
  /** ファイルを読めなかった（復号できない・壊れている）。上書きで消さないよう、取り込みの前に知らせる */
  private unreadable = false

  constructor(private readonly path: string, private readonly cipher: KeyCipher) {}

  /** 暗号化して保存できる環境か（触れずに分かる範囲） */
  persisted(): boolean {
    return this.cipher.likelyAvailable?.() ?? this.cipher.available()
  }

  /** 最初に要るときに1回だけ読む（復号は OS の鍵に触れる） */
  private async load(): Promise<StoredLogin[]> {
    if (this.logins) return this.logins
    let logins: StoredLogin[] = []
    if (existsSync(this.path) && this.cipher.available()) {
      try {
        logins = sanitizeStoredLogins(JSON.parse(this.cipher.decrypt(await readFile(this.path))))
      } catch {
        // 復号できない（鍵が変わった・壊れた）。中身は出さずに空として扱う（想定内）
        this.unreadable = true
      }
    }
    this.logins = logins
    return logins
  }

  private async save(logins: StoredLogin[]): Promise<void> {
    this.logins = logins
    if (!this.cipher.available()) return
    if (logins.length === 0) {
      await rm(this.path, { force: true })
      return
    }
    const data: StoredFile = { version: 1, logins }
    const encrypted = this.cipher.encrypt(JSON.stringify(data))
    await mkdir(dirname(this.path), { recursive: true })
    // 一時ファイルに書いてから置き換える（途中で落ちても元か新しいほうが残る）
    const tmp = `${this.path}.${process.pid}.tmp`
    try {
      await writeFile(tmp, encrypted, { mode: 0o600 })
      await rename(tmp, this.path)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    this.unreadable = false
  }

  async count(): Promise<number> {
    return (await this.load()).length
  }

  /** 前の保存を読めなかったか（取り込むと置き換わる） */
  async wasUnreadable(): Promise<boolean> {
    await this.load()
    return this.unreadable
  }

  async importLogins(incoming: readonly ImportedLogin[]): Promise<{ added: number; updated: number }> {
    const merged = mergeLogins(await this.load(), incoming)
    await this.save(merged.logins)
    return { added: merged.added, updated: merged.updated }
  }

  async clear(): Promise<void> {
    this.logins = []
    this.unreadable = false
    await rm(this.path, { force: true })
  }

  /** そのページで使える資格情報（ユーザー名と id だけ）。ユーザー名の順 */
  async accountsFor(pageUrl: string): Promise<SavedLoginAccount[]> {
    if (!loginOrigin(pageUrl)) return []
    return (await this.load())
      .filter((login) => originMatches(login.origin, pageUrl))
      .map(({ id, username }) => ({ id, username }))
      .sort((a, b) => a.username.localeCompare(b.username))
  }

  /** 選んだ1件。ページのオリジンに使えるものだけ（違えば null） */
  async loginFor(id: string, pageUrl: string): Promise<ImportedLogin | null> {
    const login = (await this.load()).find((l) => l.id === id)
    return login && originMatches(login.origin, pageUrl) ? login : null
  }
}

/** 内蔵ブラウザのページの JS とは別の世界で動かす（ページのスクリプトが入力の処理を書き換えられないように） */
const FILL_WORLD_ID = 1207

/** ページにパスワードの欄があるか（見えていて、入力できるもの） */
export const HAS_PASSWORD_FIELD_SCRIPT = `(() => Array.from(document.querySelectorAll('input[type="password"]')).some((el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0))()`

/**
 * ログインの欄へ入れるスクリプト。値は JSON で埋め込む（文字列の外に出ない）。
 * - 実行した時点のトップフレームのオリジンが expectedOrigin でなければ何もしない（main の確認のあとにページが移った場合）
 * - React などが入力を拾えるよう、要素の value ではなく HTMLInputElement の元の setter で入れ、input・change を発火する
 * - パスワードの欄が無い（ユーザー名だけの段のログイン）なら、ユーザー名の欄にだけ入れる
 * 戻り値は入れた欄の数
 */
export function buildFillScript(login: { username: string; password: string }, expectedOrigin: string): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(expectedOrigin)}) return 0
  const username = ${JSON.stringify(login.username)}
  const password = ${JSON.stringify(login.password)}
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const visible = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0
  const put = (el, value) => {
    el.focus()
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const textLike = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"]'
  const pass = Array.from(document.querySelectorAll('input[type="password"]')).find(visible) || null
  const scope = (pass && pass.form) || document
  const candidates = Array.from(scope.querySelectorAll(textLike)).filter(visible)
  let user = candidates.find((el) => (el.autocomplete || '').split(/\\s+/).includes('username')) || null
  if (!user && pass) user = candidates.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || null
  if (!user && !pass) user = candidates.find((el) => el.type === 'email') || candidates[0] || null
  let filled = 0
  if (user && username) { put(user, username); filled++ }
  if (pass) { put(pass, password); filled++ }
  return filled
})()`
}

/** トップフレームの今の URL（main が持つもの。renderer からは受け取らない） */
export function topFrameUrl(contents: WebContents): string {
  try {
    return contents.mainFrame.url || contents.getURL()
  } catch {
    // 破棄の途中（想定内）
    return ''
  }
}

/** ページにパスワードの欄があるか。調べられなければ false */
export async function pageHasPasswordField(contents: WebContents): Promise<boolean> {
  try {
    return (await contents.executeJavaScriptInIsolatedWorld(FILL_WORLD_ID, [{ code: HAS_PASSWORD_FIELD_SCRIPT }])) === true
  } catch {
    // 読み込みの途中・破棄の途中（想定内）
    return false
  }
}

/**
 * 選んだ1件をトップフレームへ入れる。その時点のトップフレームのオリジンが保存したオリジンに合うことを main で確かめてから。
 * 入れた欄の数を返す（合わなければ 0）
 */
export async function fillLogin(contents: WebContents, store: SavedLoginStore, id: string): Promise<number> {
  const pageUrl = topFrameUrl(contents)
  const login = await store.loginFor(id, pageUrl)
  const origin = loginOrigin(pageUrl)
  if (!login || !origin) return 0
  const filled = await contents.executeJavaScriptInIsolatedWorld(FILL_WORLD_ID, [{ code: buildFillScript(login, origin) }])
  return typeof filled === 'number' ? filled : 0
}
