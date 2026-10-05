/**
 * 保存したキー（と環境変数から読むヘッダー）を送ってよい接続元を、main が持つ（security-5 [6]）。
 *
 * 接続先の URL は画面（renderer）から届く。画面が乗っ取られると、保存したキーを好きな接続元へ送らせられる
 * （「接続を確かめる」や、保存した設定での文字起こし・整理・判定）。そこでキーは提供元ではなく接続元（origin）に結び付ける:
 *   - 送ってよいのは、プリセットの接続元か、利用者が main のダイアログ（接続元の名前を出す）で認めた接続元だけ
 *   - 認めた接続元は userData/credential-origins.json に main が書く（settings.json は画面からも書けるので使わない）
 *   - 設定に書いてある接続先は、初めての起動でも認めたものにしない（security-6 [3]）。プリセット以外は「接続を確かめる」で一度認めてもらう
 *   - 認めていない接続元には、キーも環境変数のヘッダーも付けずに断る（送ってから気づくのではなく、送る前に止める）
 *
 * Electron に依存させない（ダイアログは呼び出し側が confirm として渡す）。
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/** 1つの用途（例 stt:openai）で覚える接続元の数の上限 */
const MAX_ORIGINS_PER_SCOPE = 20
const MAX_SCOPES = 200
const MAX_FILE_BYTES = 256 * 1024

/** http / https の URL の接続元（https://host:port）。読めない・ほかの形なら null */
export function credentialOriginOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u.origin
  } catch {
    // 読めない URL（想定内）
    return null
  }
}

/** 暗号化しない接続元か（キーが平文で流れる。ダイアログで知らせる） */
export function isPlainHttpOrigin(origin: string): boolean {
  return origin.startsWith('http:')
}

interface StoredOrigins {
  version: 1
  approved: Record<string, string[]>
}

export class CredentialOrigins {
  private approved: Map<string, Set<string>> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  private load(): Map<string, Set<string>> {
    if (this.approved) return this.approved
    const map = new Map<string, Set<string>>()
    try {
      const text = readFileSync(this.file, 'utf8')
      if (text.length <= MAX_FILE_BYTES) {
        const raw = JSON.parse(text) as Partial<StoredOrigins>
        for (const [scope, origins] of Object.entries(raw.approved ?? {}).slice(0, MAX_SCOPES)) {
          if (!Array.isArray(origins)) continue
          const clean = origins.filter((o): o is string => typeof o === 'string' && credentialOriginOf(o) === o).slice(0, MAX_ORIGINS_PER_SCOPE)
          if (clean.length) map.set(scope, new Set(clean))
        }
      }
    } catch {
      // 無い（初めて）・壊れたファイル。壊れていれば空から（認めた接続元はもう一度聞く）
    }
    this.approved = map
    return map
  }

  /*
   * 設定（settings.json）の接続先を「認めた」ものとして移す口（以前の seedOnce）は持たない（security-6 [3]）。
   * 設定は画面や、利用者の権限で動く Agent からも書けるので、移す前に書き換えられると、その接続元へ保存したキーが送られる。
   * 認めた接続元を増やせるのは approve（main のダイアログで利用者が認めたとき）だけ
   */

  isApproved(scope: string, origin: string, defaults: ReadonlyArray<string | undefined> = []): boolean {
    if (defaults.some((d) => credentialOriginOf(d) === origin)) return true
    return this.load().get(scope)?.has(origin) ?? false
  }

  async approve(scope: string, origin: string): Promise<void> {
    if (credentialOriginOf(origin) !== origin) throw new Error('not an origin')
    this.add(this.load(), scope, origin)
    await this.save()
  }

  private add(map: Map<string, Set<string>>, scope: string, origin: string): void {
    const set = map.get(scope) ?? new Set<string>()
    set.delete(origin)
    set.add(origin)
    // 古いものから外す（上限まで）
    while (set.size > MAX_ORIGINS_PER_SCOPE) set.delete(set.values().next().value!)
    map.set(scope, set)
    if (map.size > MAX_SCOPES) map.delete(map.keys().next().value!)
  }

  private save(): Promise<void> {
    const map = this.load()
    const body: StoredOrigins = { version: 1, approved: Object.fromEntries([...map].map(([scope, set]) => [scope, [...set]])) }
    const next = this.queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      try {
        await rename(tmp, this.file)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    })
    this.queue = next
    return next
  }
}

export interface CredentialRequest {
  /** 用途と提供元（例 stt:openai・organize:anthropic・decision:custom） */
  scope: string
  /** 送る先の URL */
  url: string | undefined
  /** キー・環境変数のヘッダーなど、認証情報を付けうるか。付けないなら接続元を問わない */
  hasCredential: boolean
  /** プリセットの接続元（認めなくても送ってよい） */
  defaults: ReadonlyArray<string | undefined>
}

/**
 * 認証情報を付けて送ってよいか。認めていない接続元なら、confirm があれば接続元の名前を出して聞き（main のダイアログ）、
 * 認められたら覚える。confirm が無ければ断る
 */
export async function authorizeCredentialOrigin(req: CredentialRequest, origins: CredentialOrigins,
  confirm?: (origin: string) => Promise<boolean>): Promise<{ ok: true } | { ok: false; origin: string }> {
  if (!req.hasCredential) return { ok: true }
  const origin = credentialOriginOf(req.url)
  if (!origin) return { ok: false, origin: String(req.url ?? '') }
  if (origins.isApproved(req.scope, origin, req.defaults)) return { ok: true }
  if (confirm && await confirm(origin)) {
    await origins.approve(req.scope, origin)
    return { ok: true }
  }
  return { ok: false, origin }
}
