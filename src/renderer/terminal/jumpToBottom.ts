/**
 * 「一番下へ」のボタンを出すか。上へスクロールして、下にまだ行がある間だけ出す
 * （Agent が出力し続けていても、1回押せば最新の行まで移れる。terminalClient.ts）
 */
export function isScrolledUp(buffer: { viewportY: number; baseY: number }): boolean {
  return buffer.viewportY < buffer.baseY
}
