/**
 * Worker が受け取る env と、使う Cloudflare の API の最小限の型（feedback-relay と同じ考え方）。
 * @cloudflare/workers-types に頼らず、使う分だけを書く（単体テストの偽の env も同じ形で作る）。
 */
import type { LimiterNamespace } from '../../feedback-relay/src/env'

export type { LimiterNamespace }

/** R2 の multipart のアップロード（録画を分けて送る。1回は SHARE_LIMITS.partBytes） */
export interface MultipartUpload {
  readonly key: string
  readonly uploadId: string
  uploadPart(partNumber: number, value: ArrayBuffer | Uint8Array): Promise<{ partNumber: number; etag: string }>
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>
  abort(): Promise<void>
}

/** R2 のバケット（録画・記録・サムネイル） */
export interface ShareBucket {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>
  get(key: string, options?: { range?: { offset: number; length?: number } | { suffix: number } }): Promise<{ body: ReadableStream | null; size: number; range?: { offset?: number; length?: number } } | null>
  head(key: string): Promise<{ size: number } | null>
  delete(keys: string | string[]): Promise<void>
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<MultipartUpload>
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload
}

/** Durable Object のストレージ（KV の形の API。共有の部屋は list と delete も使う） */
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
  deleteAll(): Promise<void>
  setAlarm(time: number): Promise<void>
}

export interface RoomState {
  storage: RoomStorage
}

export interface Env {
  /** 頻度の上限の鍵と、パスワードを確かめたあとのセッションの印（HMAC）の秘密。wrangler secret put で入れる */
  RATE_LIMIT_SALT: string
  /** この Worker の公開 URL（末尾の / なし）。相手の画面の Origin の確認と、共有のリンクに使う */
  PUBLIC_BASE: string
  MEDIA: ShareBucket
  /** 共有1つにつき1つの部屋（ShareRoom） */
  ROOMS: LimiterNamespace
  /** 頻度の上限（feedback-relay の FeedbackLimiter） */
  LIMITER: LimiterNamespace
}
