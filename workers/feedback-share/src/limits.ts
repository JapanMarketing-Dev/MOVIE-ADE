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
export const CREATE_PER_SENDER: readonly Window[] = [{ windowMs: HOUR, max: 30 }, { windowMs: DAY, max: 100 }]
/** 共有を作る数の全体の上限 */
export const CREATE_GLOBAL: readonly Window[] = [{ windowMs: DAY, max: 2000 }]
/** 持ち主の操作（中身を取る・変える・断る）の IP ごとの上限。トークンが違うものも数える */
export const OWNER_PER_IP: readonly Window[] = [{ windowMs: HOUR, max: 1200 }, { windowMs: DAY, max: 6000 }]
/** パスワードの確認の試み。IP と共有の組・共有ごと・IP ごと（総当たり対策。外れたものも合ったものも数える） */
export const UNLOCK_PER_IP_SHARE: readonly Window[] = [{ windowMs: HOUR, max: 8 }, { windowMs: DAY, max: 30 }]
export const UNLOCK_PER_SHARE: readonly Window[] = [{ windowMs: HOUR, max: 60 }, { windowMs: DAY, max: 300 }]
export const UNLOCK_PER_IP: readonly Window[] = [{ windowMs: HOUR, max: 60 }, { windowMs: DAY, max: 200 }]
/** 録画を始める数。IP ごと・共有ごと・全体 */
export const RECORDING_PER_IP: readonly Window[] = [{ windowMs: HOUR, max: 20 }, { windowMs: DAY, max: 60 }]
export const RECORDING_PER_SHARE: readonly Window[] = [{ windowMs: HOUR, max: 40 }]
export const RECORDING_GLOBAL: readonly Window[] = [{ windowMs: HOUR, max: 600 }, { windowMs: DAY, max: 3000 }]

/** パスワードを確かめたあとのセッションの長さ */
export const SESSION_MS = 12 * HOUR
/** 送り終わらない録画（途中で閉じた）を片付けるまで */
export const PENDING_UPLOAD_MS = 2 * HOUR
