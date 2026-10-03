/**
 * 文字起こしの API キーの保管。
 *
 * キーは settings.json に入れず、OS の鍵の仕組み（Electron の safeStorage）で暗号化した
 * 別のファイル（userData/stt-keys.bin）へ保存する。
 * - macOS: Keychain の「<アプリ名> Safe Storage」の鍵で暗号化する
 * - Windows: DPAPI（ログインユーザーに結びつく）で暗号化する
 * - Linux: libsecret / KWallet の鍵で暗号化する。鍵束が無く basic_text（固定の鍵）に
 *   落ちる環境は「暗号化できない」とみなし、保存せず起動中だけ持つ
 *
 * 暗号化できない環境では、これまでと同じく起動中だけ保持する。
 * 開発用の .env の OPENAI_API_KEY は、dev 起動（app.isPackaged が false）のときだけ、
 * 保存したキーが無いときの OpenAI のキーとして使う。**配布版は環境変数のキーを一切読まない**
 * （開発者のキーで利用者の文字起こしを払わない。キーが無ければ端末内の whisper を案内するだけ）。
 * **キーの値はログ・エラーメッセージ・IPC の戻り値に出さないこと。**
 *
 * Electron に依存させない（単体テストで暗号化の可否を差し替えるため）。safeStorage は呼び出し側で渡す。
 */
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SttKeySource } from '@shared/types'
import { AI_VENDORS, type AiVendor } from '@shared/aiProviders'
import { t } from '@shared/i18n'

/** キーを保存する単位。提供元（vendor）ごとに1つで、文字起こしと整理で共有する */
export type SttKeyProvider = AiVendor

/** safeStorage の必要な部分だけ */
export interface KeyCipher {
  /** 安全に暗号化できるか（Linux の basic_text は false にすること） */
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

const PROVIDERS: readonly SttKeyProvider[] = AI_VENDORS

/**
 * キーの形式を確かめる。OpenAI は sk- で始まるキーだけ、互換サーバーは空白を含まない
 * 表示可能な ASCII（Groq の gsk_…、自前サーバーの任意のトークン）。問題なければ null。
 */
export function validateSttKey(provider: SttKeyProvider, key: string): string | null {
  if (provider === 'openai') {
    return /^sk-[A-Za-z0-9_-]{15,500}$/.test(key) ? null : t('stt.key.badOpenai')
  }
  return /^[\x21-\x7e]{1,500}$/.test(key) ? null : t('stt.key.badFormat')
}

export class SttKeyStore {
  private readonly keys: Partial<Record<SttKeyProvider, string>> = {}
  /** 暗号化して保存できているキー */
  private readonly persisted = new Set<SttKeyProvider>()
  private loaded = false

  constructor(
    private readonly file: string,
    private readonly cipher: KeyCipher,
    /** キーとして読んでよい環境変数。既定は空（読まない）。dev 起動だけ devKeyEnv で渡す */
    private readonly env: NodeJS.ProcessEnv = {},
  ) {}

  /** 保存方式。画面に「保存しません」を出すかどうかに使う */
  storage(): 'encrypted' | 'session' {
    return this.cipher.available() ? 'encrypted' : 'session'
  }

  /**
   * 保存済みのキーを読む。初めて使う時点で1度だけ呼ぶ（macOS では Keychain に触れるため、起動時には読まない）。
   * 読めない（別の端末からコピーした・鍵が消えた）ファイルは無視する。
   */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.cipher.available()) return
    let data: Buffer
    try { data = await readFile(this.file) } catch { return }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(data)) as Record<string, unknown>
      for (const p of PROVIDERS) {
        const v = parsed[p]
        // 起動中に入れたキーを、後から読んだ古い値で上書きしない
        if (typeof v === 'string' && v && this.keys[p] === undefined) {
          this.keys[p] = v
          this.persisted.add(p)
        }
      }
    } catch {
      console.warn('[stt] 保存済みのAPIキーを復号できませんでした。もう一度入力してください。')
    }
  }

  /** 送信に使うキー。OpenAI は保存したキーが無ければ .env の OPENAI_API_KEY */
  get(provider: SttKeyProvider): string | undefined {
    return this.keys[provider] ?? (provider === 'openai' ? this.env.OPENAI_API_KEY || undefined : undefined)
  }

  source(provider: SttKeyProvider): SttKeySource {
    if (this.keys[provider]) return this.persisted.has(provider) ? 'saved' : 'session'
    return provider === 'openai' && this.env.OPENAI_API_KEY ? 'env' : null
  }

  /**
   * キーを設定する。空文字は解除。暗号化できれば保存し、できなければ起動中だけ持つ。
   * 形式が違えば日本語のエラーを投げる（キーの値はメッセージに含めない）。
   */
  async set(provider: SttKeyProvider, key: string): Promise<{ persisted: boolean }> {
    await this.load()
    const trimmed = key.trim()
    if (trimmed) {
      const invalid = validateSttKey(provider, trimmed)
      if (invalid) throw new Error(invalid)
      this.keys[provider] = trimmed
    } else {
      delete this.keys[provider]
    }
    this.persisted.delete(provider)
    if (!this.cipher.available()) return { persisted: false }
    try {
      await this.write()
    } catch {
      console.warn('[stt] APIキーを保存できませんでした。この起動中だけ使います。')
      return { persisted: false }
    }
    if (trimmed) this.persisted.add(provider)
    return { persisted: !!trimmed }
  }

  /** 保存済みの分も含めて暗号化して書き直す。キーが1つも無ければファイルを消す */
  private async write(): Promise<void> {
    const entries = PROVIDERS.flatMap((p) => (this.keys[p] ? [[p, this.keys[p]] as const] : []))
    if (entries.length === 0) {
      await rm(this.file, { force: true })
      return
    }
    await mkdir(dirname(this.file), { recursive: true })
    // 中身は暗号化済みだが、念のため本人だけが読める権限にする（Windows では無視される）
    await writeFile(this.file, this.cipher.encrypt(JSON.stringify(Object.fromEntries(entries))), { mode: 0o600 })
    for (const [p] of entries) this.persisted.add(p)
  }
}

/** キーとして読んでよい環境変数。配布版（isPackaged）は空にして、利用者・開発者どちらの環境変数も使わない */
export function devKeyEnv(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return isPackaged ? {} : env
}

/**
 * 開発用の .env を読む。dev 起動のときだけ。配布物には .env を含めない（electron-builder の files で除外）。
 * 読んだら true。
 */
export function loadDevDotEnv(isPackaged: boolean, path = '.env', load: (path: string) => void = process.loadEnvFile): boolean {
  if (isPackaged || !existsSync(path)) return false
  load(path)
  return true
}

/**
 * Electron の safeStorage を KeyCipher にする。
 * Linux で鍵束が無いと basic_text（ソースに書かれた固定の鍵）になり、実質平文なので使わない。
 */
export function safeStorageCipher(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
  getSelectedStorageBackend?(): string
}, platform: NodeJS.Platform = process.platform): KeyCipher {
  return {
    available: () => {
      if (!safeStorage.isEncryptionAvailable()) return false
      if (platform !== 'linux') return true
      const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
      return backend !== 'basic_text' && backend !== 'unknown'
    },
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  }
}
