/**
 * 確認待ちのコメント欄のキー（FindingProgress の VerdictPanel）。
 * Enter・⌘/Ctrl+Enter で NG を付けてその1件をすぐ Agent へ送る。日本語などの変換を確定する Enter（isComposing・keyCode 229）では送らない。
 * Shift+Enter・Alt+Enter は改行（何もしない）
 */
export interface VerdictKey {
  key: string
  shiftKey: boolean
  altKey: boolean
  isComposing: boolean
  keyCode: number
}

export function verdictKeySends(e: VerdictKey): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229
}
