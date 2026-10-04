/**
 * ブラケットペーストの枠（main の Agent への送信と、renderer のターミナルの貼り付けで共通）。
 * 枠の中の改行は送信ではなく本文として TUI（Claude Code など）に届く
 */

/** ブラケットペーストの開始 */
export const BRACKETED_PASTE_START = '\x1b[200~'
/** ブラケットペーストの終了 */
export const BRACKETED_PASTE_END = '\x1b[201~'
