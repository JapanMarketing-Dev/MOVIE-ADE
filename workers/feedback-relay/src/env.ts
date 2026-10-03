/**
 * Worker が受け取る env と、使う Cloudflare の API の最小限の型。
 * @cloudflare/workers-types に頼らず、使う分だけを書く（単体テストの偽の env も同じ形で作る）。
 */

/** R2 のバケット（使うのは put / get / delete だけ） */
export interface MediaBucket {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream | null; httpMetadata?: { contentType?: string } } | null>
  delete(key: string): Promise<void>
}

/** Durable Object の名前空間（fetch で話す。RPC は使わない） */
export interface LimiterNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** Durable Object のストレージ（KV の形の API だけ） */
export interface LimiterStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  deleteAll(): Promise<void>
  setAlarm(time: number): Promise<void>
}

export interface LimiterState {
  storage: LimiterStorage
}

export interface Env {
  /** GitHub の fine-grained トークン（ferret リポジトリの Issues: write だけ）。wrangler secret put で入れる */
  GITHUB_TOKEN: string
  /** 頻度の上限の鍵を作る HMAC の秘密。wrangler secret put で入れる。IP やインストール ID はこれで HMAC にしてから使う */
  RATE_LIMIT_SALT: string
  /** Issue を作るリポジトリ（owner/name） */
  GITHUB_REPO: string
  /** この Worker の公開 URL（末尾の / なし）。画像の URL に使う */
  PUBLIC_BASE: string
  MEDIA: MediaBucket
  LIMITER: LimiterNamespace
}
