/**
 * 共有の Worker だけが使う値（パスと頻度の上限）。共有の形と大きさの正本は src/shared/feedbackShare.ts。
 */
import type { Window } from '../../feedback-relay/src/limiter'

export const API_PREFIX = '/v1/shares'
export const PUBLIC_API_PREFIX = '/v1/public/'
export const ASSET_PREFIX = '/assets/'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** 共有を作る数。IP（の HMAC）ごと・インストール ID（送られたとき）ごと */
export const CREATE_PER_SENDER: readonly Window[] = [{ windowMs: HOUR, max: 10 }, { windowMs: DAY, max: 30 }]
/** 共有を作る数の全体の上限 */
export const CREATE_GLOBAL: readonly Window[] = [{ windowMs: DAY, max: 1000 }]
/** 持ち主の操作（ページを足す・一覧を取る・断る）の IP ごとの上限。トークンが違うものも数える */
export const OWNER_PER_IP: readonly Window[] = [{ windowMs: HOUR, max: 600 }, { windowMs: DAY, max: 3000 }]
/** 相手の指摘の送信。IP ごと */
export const COMMENT_PER_IP: readonly Window[] = [{ windowMs: HOUR, max: 60 }, { windowMs: DAY, max: 300 }]
/** 相手の指摘の送信。共有ごと（大勢から一度に来ても、持ち主の一覧が埋まりきらないように） */
export const COMMENT_PER_SHARE: readonly Window[] = [{ windowMs: HOUR, max: 200 }]
/** 相手の指摘の送信の全体の上限 */
export const COMMENT_GLOBAL: readonly Window[] = [{ windowMs: HOUR, max: 3000 }, { windowMs: DAY, max: 20000 }]
/** ページを足す本文（multipart）の大きさの上限 */
export const MAX_PAGE_REQUEST_BYTES = 5 * 1024 * 1024
