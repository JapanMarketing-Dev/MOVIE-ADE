/**
 * Worker が受け取る env と、使う Cloudflare の API の最小限の型（feedback-relay と同じ考え方）。
 * @cloudflare/workers-types に頼らず、使う分だけを書く（単体テストの偽の env も同じ形で作る）。
 */
import type { LimiterNamespace, MediaBucket } from '../../feedback-relay/src/env'

export type { LimiterNamespace, MediaBucket }

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
  /** 頻度の上限の鍵を作る HMAC の秘密。wrangler secret put で入れる。IP やインストール ID はこれで HMAC にしてから使う */
  RATE_LIMIT_SALT: string
  /** この Worker の公開 URL（末尾の / なし）。相手の画面の Origin の確認と、共有のリンクに使う */
  PUBLIC_BASE: string
  MEDIA: MediaBucket
  /** 共有1つにつき1つの部屋（ShareRoom） */
  ROOMS: LimiterNamespace
  /** 頻度の上限（feedback-relay の FeedbackLimiter） */
  LIMITER: LimiterNamespace
}
