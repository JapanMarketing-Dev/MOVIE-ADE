/**
 * 製品名の付いた環境変数（FERRET_*）。改名前の MOVIE_ADE_* も非推奨の別名として受け付ける。
 * 新しい名前が定義されていればそちらを使う（空の値も「指定した」とみなす。例: FERRET_SENTRY_DSN= で送らない）。
 */

const ENV_PREFIX = 'FERRET_'
/** @deprecated 改名前（MOVIE-ADE）の接頭辞。読むだけで、新しく書かない */
const LEGACY_ENV_PREFIX = 'MOVIE_ADE_'

/** FERRET_<suffix> を読み、無ければ MOVIE_ADE_<suffix> を読む */
export function readBrandEnv(env: Record<string, string | undefined>, suffix: string): string | undefined {
  return env[`${ENV_PREFIX}${suffix}`] ?? env[`${LEGACY_ENV_PREFIX}${suffix}`]
}
