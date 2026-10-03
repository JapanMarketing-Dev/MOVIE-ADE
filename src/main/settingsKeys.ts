import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { readTextBoundedSync } from './boundedFile'
import { fillAccountId, resolveHeaderValues, type AiEndpointConfig } from '@shared/aiProviders'

/**
 * settings.json から指定する API キー（apiKey / apiKeyEnv）の解決。
 *
 * 優先順: settings.json の平文の apiKey > apiKeyEnv（環境変数 → プロジェクトの .env → 設定フォルダの .env）> 保存したキー（pipeline/stt/keys.ts）。
 * - apiKeyEnv は利用者が名前を書いたときだけ読む。配布版でも読む（利用者自身の環境変数を、利用者が指定して使うため）。
 *   名前の無い既定の環境変数（OPENAI_API_KEY など）を勝手に読むことはしない（開発者のキーで払わない方針は keys.ts のまま）
 * - Finder から起動したアプリはシェルの環境変数を受け取らないので、設定フォルダの .env（~/.ferret/.env）も探す
 * - キーの値はログ・エラー・IPC の戻り値・Sentry に出さないこと
 */

export interface KeyRef {
  apiKey?: string
  apiKeyEnv?: string
}

export type ConfiguredKeySource = 'config' | 'configEnv'

export interface KeyLookup {
  env: NodeJS.ProcessEnv
  /** 開いているプロジェクトのフォルダ（その .env を読む） */
  projectDir?: string | null
  /** 設定フォルダ（その .env を読む） */
  configDir?: string | null
  /** 単体テストで差し替える */
  readText?: (path: string) => string
}

function readDotEnv(dir: string | null | undefined, name: string, read: (path: string) => string): string | undefined {
  if (!dir) return undefined
  try {
    const value = parseEnv(read(join(dir, '.env')))[name]
    return value?.trim() || undefined
  } catch {
    // .env が無い・読めない（想定内）
    return undefined
  }
}

/** .env として読む大きさの上限 */
const DOTENV_MAX_BYTES = 256 * 1024

/** 環境変数を 環境 → プロジェクトの .env → 設定フォルダの .env の順に探す */
export function lookupEnv(name: string, lookup: KeyLookup): string | undefined {
  // .env はプロジェクト側が用意するファイル。名前付きパイプ・巨大なファイル・リンク先で main が止まらないよう、大きさを決めて辿らずに読む
  const read = lookup.readText ?? ((path: string) => readTextBoundedSync(path, DOTENV_MAX_BYTES, { noFollow: true }))
  return lookup.env[name]?.trim() || readDotEnv(lookup.projectDir, name, read) || readDotEnv(lookup.configDir, name, read)
}

/**
 * 送信の前に接続先の参照を解決する（文字起こし・整理・判定で共通）。
 * baseUrl の {account_id} を accountId（無ければ CLOUDFLARE_ACCOUNT_ID）で置き換え、headers の { env } を環境変数から読んで文字列にする。
 * 見つからない環境変数のヘッダーは付けない。
 */
export function resolveEndpointRefs<T extends AiEndpointConfig>(endpoint: T | undefined, lookup: KeyLookup): T | undefined {
  if (!endpoint) return endpoint
  const getEnv = envGetter(lookup)
  const out = { ...endpoint }
  if (out.baseUrl) out.baseUrl = fillAccountId(out.baseUrl, endpoint.accountId, getEnv)
  if (endpoint.headers) out.headers = resolveHeaderValues(endpoint.headers, getEnv)
  return out
}

/** lookupEnv を名前だけで呼べる形にする（共通の resolveHeaderValues / fillAccountId に渡す） */
export function envGetter(lookup: KeyLookup): (name: string) => string | undefined {
  return (name) => lookupEnv(name, lookup)
}

/** settings.json で指定したキー。指定が無い・見つからなければ null */
export function resolveConfiguredKey(ref: KeyRef | undefined, lookup: KeyLookup): { key: string; source: ConfiguredKeySource } | null {
  const plain = ref?.apiKey?.trim()
  if (plain) return { key: plain, source: 'config' }
  const name = ref?.apiKeyEnv?.trim()
  if (!name) return null
  const value = lookupEnv(name, lookup)
  return value ? { key: value, source: 'configEnv' } : null
}

/** 送信に使うキー。settings.json の指定が先、無ければ保存したキー（復号はここで初めて行う） */
export async function resolveApiKey(ref: KeyRef | undefined, lookup: KeyLookup, saved: () => Promise<string | undefined>): Promise<string | undefined> {
  return resolveConfiguredKey(ref, lookup)?.key ?? (await saved())
}

/** renderer へ渡す前に平文のキーを外す（設定の画面には値を出さない） */
export function redactKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactKeys) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    key === 'apiKey' ? [] : [[key, redactKeys(v)]])) as T
}

/**
 * 設定の画面から届いた接続先の表（キーを外した写し）に、settings.json にあったキーの指定を戻す。
 * 画面で保存しても、利用者がファイルに書いた apiKey / apiKeyEnv を消さない。
 */
export function keepKeyRefs<T extends Record<string, KeyRef | undefined>>(prev: Partial<T> | undefined, next: Partial<T> | undefined): Partial<T> | undefined {
  if (!next) return next
  const out: Record<string, KeyRef | undefined> = { ...next }
  for (const [provider, before] of Object.entries(prev ?? {}) as Array<[string, KeyRef | undefined]>) {
    if (!before?.apiKey && !before?.apiKeyEnv) continue
    const after = out[provider] ?? {}
    out[provider] = { ...after, ...(before.apiKey && !after.apiKey ? { apiKey: before.apiKey } : {}), ...(before.apiKeyEnv && !('apiKeyEnv' in after) ? { apiKeyEnv: before.apiKeyEnv } : {}) }
  }
  return out as Partial<T>
}
