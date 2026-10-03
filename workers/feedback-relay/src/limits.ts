/**
 * 中継の仕様。アプリと共有する値の正本は src/shared/feedbackRelay.ts（github-integration と合わせたもの）で、ここは re-export する。
 * 中継だけが使う値（パス・ラベル・頻度の上限・連投の期間）をここに足す。
 */
export {
  ALLOWED_FIELDS,
  ARCHES,
  ERROR_STATUS,
  KINDS,
  MAX_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_REQUEST_BYTES,
  MAX_TITLE_CHARS,
  PLATFORMS,
  type ErrorCode,
  type FieldName
} from '../../../src/shared/feedbackRelay'

export const ISSUES_PATH = '/v1/issues'
export const MEDIA_PATH_PREFIX = '/v1/media/'

/** Issue に必ず付けるラベル（kind のラベルに加えて） */
export const FROM_APP_LABEL = 'from-app'

/** 頻度の上限。IP（の HMAC）ごと・インストール ID（の HMAC。送られたときだけ）ごとに、どちらも */
export const PER_SENDER_LIMITS = [
  { windowMs: 60 * 60 * 1000, max: 5 },
  { windowMs: 24 * 60 * 60 * 1000, max: 20 }
] as const
/**
 * 本文を読む前に IP（の HMAC）ごとに数える、送信の試みの上限（security-3 [4]）。
 * 形の悪いもの・断ったものも数える。Issue になった数（PER_SENDER_LIMITS・GLOBAL_LIMITS）とは別に数え、全体の枠は食わない
 */
export const ATTEMPT_LIMITS = [
  { windowMs: 60 * 60 * 1000, max: 30 },
  { windowMs: 24 * 60 * 60 * 1000, max: 100 }
] as const
/** 全体の上限（大量の IP から来ても、Issue が際限なく増えないように） */
export const GLOBAL_LIMITS = [{ windowMs: 24 * 60 * 60 * 1000, max: 200 }] as const
/** 同じ題名と本文を弾く期間 */
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000
