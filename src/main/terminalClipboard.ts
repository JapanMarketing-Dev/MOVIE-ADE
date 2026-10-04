import type { ProgramCopyResult, TerminalClipboardMode } from '@shared/types'

/**
 * 端末の中のプログラムが OSC 52 で求めたコピー（security-5 [9]）。
 *
 * 端末の出力は信用しない（プロジェクトのコマンド・Agent・SSH 先が書ける）。既定（ask）では写さずに預かり、
 * 端末の下の帯で利用者が［コピー］を押したときだけ写す。設定で「常に許可」にしても、写すのは手元の端末に
 * フォーカスがあるときだけで、写したことを帯で知らせる。SSH 先の端末はいつも確認する。off なら何もしない
 */

/** 預かる文字数の上限（OSC 52 は base64 で 128K 文字まで。terminalOsc52.ts） */
export const PROGRAM_COPY_MAX_CHARS = 128 * 1024
/** 預かったコピーを［コピー］で写せる間 */
export const PROGRAM_COPY_PENDING_MS = 120_000
const PREVIEW_CHARS = 80

export function normalizeTerminalClipboardMode(raw: unknown): TerminalClipboardMode {
  return raw === 'allow' || raw === 'off' ? raw : 'ask'
}

/** 写す（copy）・確認する（ask）・捨てる（drop） */
export function programCopyDecision(input: { mode: TerminalClipboardMode; remote: boolean; windowFocused: boolean; terminalFocused: boolean }): 'copy' | 'ask' | 'drop' {
  if (input.mode === 'off') return 'drop'
  if (input.mode === 'allow' && !input.remote && input.windowFocused && input.terminalFocused) return 'copy'
  return 'ask'
}

/** 帯に出す先頭の1行（制御文字は見せない） */
export function programCopyPreview(text: string): string {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').trim()
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line
}

/** ターミナルごとに、確認待ちのコピーを1つだけ預かる（新しいものが来たら古いものは捨てる） */
export class ProgramCopies {
  private pending = new Map<string, { text: string; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 求めを受ける。copy なら写す文字列を返し、ask なら預かって帯に出す内容を返す
   */
  offer(id: string, text: unknown, decision: 'copy' | 'ask' | 'drop'): { result: ProgramCopyResult; write: string | null } {
    if (typeof id !== 'string' || typeof text !== 'string' || text.length === 0 || text.length > PROGRAM_COPY_MAX_CHARS || decision === 'drop') {
      return { result: { kind: 'blocked' }, write: null }
    }
    if (decision === 'copy') {
      this.pending.delete(id)
      return { result: { kind: 'copied', chars: text.length }, write: text }
    }
    this.pending.set(id, { text, at: this.now() })
    return { result: { kind: 'ask', chars: text.length, preview: programCopyPreview(text) }, write: null }
  }

  /** ［コピー］を押した。預かった文字列を1回だけ渡す（古ければ捨てる） */
  take(id: string): string | null {
    const entry = this.pending.get(id)
    this.pending.delete(id)
    if (!entry) return null
    const age = this.now() - entry.at
    return age >= 0 && age <= PROGRAM_COPY_PENDING_MS ? entry.text : null
  }

  forget(id: string): void {
    this.pending.delete(id)
  }
}
