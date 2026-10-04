/**
 * OSC 52（端末の中のプログラムからクリップボードへ写す）の中身を読む（純粋な関数。単体テストの対象）。
 *
 * xterm.js 5.5 は OSC 52 を扱わないので、Claude Code・OpenCode・tmux・Zellij・SSH 先の vim などの「コピー」が
 * クリップボードに届かない（Orca #8977 #10567 #22842）。
 * Orca由来: ~/bench/orca/src/renderer/src/components/terminal-pane/osc52-clipboard.ts（MIT）の考え方
 *   - 形は「Pc;Pd」。Pc は c / p / s などの種類（どれもクリップボードへ）、Pd は base64 の UTF-8
 *   - Pd が「?」は読み出しの問い合わせ。クリップボードの中身を端末の中へ漏らさないため答えない
 *   - 大きすぎるものは捨てる（base64 で 128K 文字まで）
 * 書き込みだけで、読み出しは扱わない。画面を読み込み直したあとの流し直しの間は書かない（terminalClient.ts）
 */
export const MAX_OSC52_BASE64_CHARS = 128 * 1024

type Osc52Request = { kind: 'write'; text: string } | { kind: 'query' } | { kind: 'invalid' }

export function parseOsc52(data: string): Osc52Request {
  const separator = data.indexOf(';')
  if (separator < 0) return { kind: 'invalid' }
  const selections = data.slice(0, separator)
  const payload = data.slice(separator + 1)
  if (!/^[cpqs0-7]*$/.test(selections)) return { kind: 'invalid' }
  if (payload === '?') return { kind: 'query' }
  if (payload.length > MAX_OSC52_BASE64_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return { kind: 'invalid' }
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    return { kind: 'write', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { kind: 'invalid' }
  }
}
