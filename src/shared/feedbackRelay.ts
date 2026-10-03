/**
 * 匿名フィードバックの中継（workers/feedback-relay。Cloudflare Worker → GitHub Issue）の仕様。
 * アプリ（src/main/feedbackRelay.ts）と中継の両方がこの値を使う（正本はここ。中継の limits.ts が re-export する）。
 *
 *   POST https://feedback.ferretade.dev/v1/issues   multipart/form-data（画像が無くても同じ形）
 *   成功 201 {"ok":true,"issue":123,"url":"https://github.com/..."}
 *   失敗     {"ok":false,"code":"<ErrorCode>"}（詳しい理由は返さない）
 */

export const FEEDBACK_RELAY_ORIGIN = 'https://feedback.ferretade.dev'
export const FEEDBACK_RELAY_URL = `${FEEDBACK_RELAY_ORIGIN}/v1/issues`

/** 受け付けるフィールドの名前。これ以外が1つでもあれば unknown_field で断られる */
export const ALLOWED_FIELDS = ['kind', 'title', 'body', 'appVersion', 'platform', 'arch', 'osRelease', 'installId', 'image'] as const
export type FieldName = (typeof ALLOWED_FIELDS)[number]

export const KINDS = ['bug', 'enhancement'] as const
export const PLATFORMS = ['darwin', 'win32', 'linux'] as const
export const ARCHES = ['x64', 'arm64'] as const

export const MAX_TITLE_CHARS = 200
export const MAX_BODY_BYTES = 20 * 1024
export const MAX_IMAGES = 3
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024
/** アプリの側の時間の上限 */
export const RELAY_TIMEOUT_MS = 30_000

/** 失敗のときに返る code と HTTP の状態 */
export const ERROR_STATUS = {
  invalid_request: 400,
  unknown_field: 400,
  invalid_kind: 400,
  invalid_title: 400,
  invalid_body: 400,
  invalid_meta: 400,
  too_many_images: 400,
  origin_not_allowed: 403,
  not_found: 404,
  method_not_allowed: 405,
  duplicate: 409,
  too_large: 413,
  image_too_large: 413,
  unsupported_media_type: 415,
  bad_image: 415,
  rate_limited: 429,
  internal: 500,
  upstream_failed: 502
} as const
export type ErrorCode = keyof typeof ERROR_STATUS

/** 送り直してよい code（429 は Retry-After のあと）。ほかは同じ内容で送り直しても同じ結果になる */
export const RETRYABLE_CODES: readonly ErrorCode[] = ['rate_limited', 'upstream_failed', 'internal']

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_STATUS, value)
}
