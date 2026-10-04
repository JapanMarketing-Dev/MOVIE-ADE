/**
 * ターミナルで xterm より先に受けるキー（純粋な関数。単体テストの対象）。
 *
 * Orca の terminal-shortcut-policy.ts / keybindings（terminal.copySelection・terminal.paste）と同じ割り当て:
 *   - Shift+Enter: Agent が前面にいるときだけ ESC+CR を送る。xterm は Enter と同じ CR を送るため、Claude Code などで改行できず
 *     送信になる（Orca #2412 #9703 #12541）。シェル（cmd.exe・PowerShell は ESC で行を消す）では今どおり Enter
 *   - Windows / Linux: Ctrl+Shift+C と「選択があるときの Ctrl+C」でコピー。選択が無い Ctrl+C は今どおり中断（^C）（Orca #5611 #5352）
 *   - Windows / Linux: Ctrl+V・Ctrl+Shift+V・Shift+Insert で貼り付け。xterm は Ctrl+V を ^V として送ってしまう（Orca #560）
 *   - macOS: ⌘← / ⌘→ は行頭・行末（Ctrl+A / Ctrl+E）、⌘⌫ は行頭まで消す（Ctrl+U）。xterm は何も送らない（Orca #5797）
 *   - macOS: ⌥⌦ は次の単語を消す（ESC d）。xterm の既定 ESC[3;3~ はシェルに ~ を入れる（Orca #21491）
 * ⌘C / ⌘V（macOS）はメニューの標準ロールが受けるので、ここでは扱わない。
 * 変換中（IME）のキーは何もしない（確定の Enter などを横取りしない）。
 */

import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '@shared/bracketedPaste'

export interface TerminalKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

type TerminalKeyAction = { kind: 'send'; data: string } | { kind: 'copy' } | { kind: 'paste' }

interface TerminalKeyContext {
  hasSelection: boolean
  /** 前面で Agent（Claude Code / Codex など）が動いている */
  agentForeground: boolean
}

export function terminalKeyAction(event: TerminalKeyEvent, platform: string, context: TerminalKeyContext): TerminalKeyAction | null {
  if (event.isComposing || event.keyCode === 229) return null
  const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  if (key === 'Enter' && shift && !ctrl && !meta && !alt) return context.agentForeground ? { kind: 'send', data: '\x1b\r' } : null

  if (platform === 'darwin') {
    if (meta && !ctrl && !alt && !shift) {
      if (key === 'ArrowLeft') return { kind: 'send', data: '\x01' }
      if (key === 'ArrowRight') return { kind: 'send', data: '\x05' }
      if (key === 'Backspace') return { kind: 'send', data: '\x15' }
    }
    if (alt && !ctrl && !meta && !shift && key === 'Delete') return { kind: 'send', data: '\x1bd' }
    return null
  }

  if (meta || alt) return null
  if (ctrl && shift && key === 'c') return { kind: 'copy' }
  if (ctrl && !shift && key === 'c' && context.hasSelection) return { kind: 'copy' }
  if (ctrl && key === 'v') return { kind: 'paste' }
  if (!ctrl && shift && key === 'Insert') return { kind: 'paste' }
  return null
}

/**
 * Windows で Agent が前面にいるときの複数行の貼り付け（Orca #5274）。xterm はアプリがブラケットペーストを有効にした
 * （DECSET 2004）ときだけ枠で包むが、Windows の ConPTY はその知らせを xterm まで通さないことがあり、包まれない改行が
 * 1行ずつの送信になる。改行を含むときは自分で枠に包み（改行は xterm と同じく CR）、PTY へそのまま書く文字列を返す。
 * ほか（macOS / Linux、1行、xterm が既に包む、シェルだけ）は null（xterm の term.paste に任せる）。
 * 本文の中の枠の印は消す（貼った文字で枠を閉じて、後ろをキー入力として実行させない）
 */
export function windowsAgentPasteData(text: string, platform: string, context: { agentForeground: boolean; bracketedPasteMode: boolean }): string | null {
  if (platform !== 'win32' || !context.agentForeground || context.bracketedPasteMode || !/[\r\n]/.test(text)) return null
  const body = text.replace(/\r?\n/g, '\r').replace(/\x1b\[20[01]~/g, '')
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`
}
