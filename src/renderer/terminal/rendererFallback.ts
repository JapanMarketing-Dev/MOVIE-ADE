/**
 * ターミナルの WebGL 描画を使えなかった理由が、端末の環境（GPU が無い・ブロックリスト・仮想マシン・
 * リモートデスクトップ）によるものか。xterm の WebGL addon は WebGL2 の文脈を取れないと
 * `WebGL2 not supported <文脈>` を投げる。これは不具合ではなく Canvas へ切り替えて続けるだけなので、Sentry へは送らない
 * （Linux の画面の無い環境の起動のたびに FERRET-13 として届いていた）
 */
export function isWebglUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /^WebGL2 not supported\b/.test(message)
}
