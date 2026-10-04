import { randomBytes } from 'node:crypto'

/**
 * プレビューの「外部の画像を読み込む」の許可（security-4 [6]）。
 *
 * 以前は `?remote-images=1` が付いていれば許していた。この形はプロジェクトの Markdown のリンクでも作れて、
 * 開いていた URL として保存・復元もされた。そこで許可は main のメモリにだけ置く推測できない合言葉にする:
 * - 出すのは、ページのボタン（page.js）からの POST に、決めた見出しが付いているときだけ。
 *   Markdown のリンク・画像・手入力の URL は GET の遷移なので、どの形でも出せない（生の HTML は文字にしている）
 * - 合言葉はその文書のパスに結び付け、1回の表示で使い切る。短い時間で切れる
 * - URL に残った合言葉は使い切り済みなので、保存・復元・戻るで許可は戻らない（保存する URL からは剥がす。@shared/preview）
 * 純粋な部分だけを置き、electron は読まない（単体テストから使う）。
 */

/** ボタンが付ける見出し。リンクの遷移では付けられない */
export const REMOTE_IMAGES_GRANT_HEADER = 'x-ferret-remote-images'
export const REMOTE_IMAGES_GRANT_VALUE = 'grant'
/** 合言葉が使えるまでの時間（押してすぐ読み直すので短く） */
export const REMOTE_IMAGES_GRANT_TTL_MS = 60_000
/** 同時に持つ合言葉の上限（押し続けてもメモリが増えない） */
export const MAX_REMOTE_IMAGES_GRANTS = 32

interface Grant {
  path: string
  expiresAt: number
}

const grants = new Map<string, Grant>()

function prune(now: number): void {
  for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token)
  // 古いものから捨てる（Map は入れた順）
  while (grants.size >= MAX_REMOTE_IMAGES_GRANTS) grants.delete(grants.keys().next().value as string)
}

/** ボタンからの要求か（POST と決めた見出し）。それ以外では合言葉を出さない */
export function isRemoteImagesGrantRequest(method: string, headers: { get: (name: string) => string | null }): boolean {
  return method.toUpperCase() === 'POST' && headers.get(REMOTE_IMAGES_GRANT_HEADER) === REMOTE_IMAGES_GRANT_VALUE
}

/** その文書だけに使える合言葉を出す */
export function issueRemoteImagesGrant(path: string, now: number = Date.now()): string {
  prune(now)
  const token = randomBytes(24).toString('base64url')
  grants.set(token, { path, expiresAt: now + REMOTE_IMAGES_GRANT_TTL_MS })
  return token
}

/** 合言葉が今の文書のものなら true にして使い切る。違う文書・切れた・知らない値なら false */
export function consumeRemoteImagesGrant(token: string | null, path: string, now: number = Date.now()): boolean {
  if (!token) return false
  const grant = grants.get(token)
  if (!grant) return false
  grants.delete(token)
  return grant.path === path && grant.expiresAt > now
}

/** テスト用 */
export function remoteImagesGrantCount(): number {
  return grants.size
}
