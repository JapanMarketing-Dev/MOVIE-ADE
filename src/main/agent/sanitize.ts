/**
 * ブラケットペーストで送る本文の整え方（04_benchmark.md 3.3）。
 *
 * - 改行は `\r` に正規化する。xterm のネイティブ paste がクリップボードの改行を全て CR に
 *   変えるため、直接書き込む経路もそれに合わせないと、生の LF を TUI が送信と解釈しうる。
 * - ESC は可視文字へ置き換える。ペーストの枠の中に ESC が入ると枠が壊れる。C1 の制御文字（8ビットの CSI など）と
 *   文字の向きを変える制御文字は落とす。
 * - 正規化は分割の**前**に全体へかける（CRLF が境界をまたがないようにするため）。
 */
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  MAX_SINGLE_WRITE_BYTES,
  PTY_WRITE_CHUNK_BYTES
} from './protocol'
import { renderAgentPrompt } from '@shared/agentPrompt'

/** 可視の ESC。本文に ESC があってもペーストの枠を壊さない */
export const VISIBLE_ESC = '␛'

/** 本文を送れる形に整える */
export function sanitizePastePayload(text: string): string {
  return (
    text
      // CRLF / LF をまとめて CR へ
      .replace(/\r?\n/g, '\r')
      // ESC を可視文字へ
      .replace(/\x1b/g, VISIBLE_ESC)
      // そのほかの制御文字（CR・タブは残す）は落とす
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      // C1 の制御文字も落とす。U+009B は 8ビットの CSI で、読み方によっては「U+009B 201~」がペーストの終わりになり、
      // 枠の外に出た残り（Enter を含む）がキー入力として扱われうる（ページの文字からの指示の注入）
      .replace(/[\u0080-\u009f]/g, '')
      // 文字の向きを変える制御文字（表示と中身を食い違わせられる）
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
  )
}

/** 1回の write で送れる長さか */
export function fitsSingleWrite(payload: string): boolean {
  return Buffer.byteLength(BRACKETED_PASTE_START + payload + BRACKETED_PASTE_END, 'utf8') <= MAX_SINGLE_WRITE_BYTES
}

/**
 * 本文を write 単位に割る。
 * マルチバイト文字の途中で割らないよう、コードポイント単位で見る。
 */
export function splitForWrite(payload: string, limitBytes = PTY_WRITE_CHUNK_BYTES): string[] {
  if (Buffer.byteLength(payload, 'utf8') <= limitBytes) return payload.length > 0 ? [payload] : []
  const out: string[] = []
  let current = ''
  let currentBytes = 0
  for (const ch of payload) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (currentBytes + size > limitBytes && current.length > 0) {
      out.push(current)
      current = ''
      currentBytes = 0
    }
    current += ch
    currentBytes += size
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * `feedback.md` を読ませる1行の指示。
 * 画像対応の Agent でも、渡すのは Markdown のパスなので `@` メンション記法は使わず素のパスで書く
 * （04_benchmark.md 3.3 の「本システムは…素のパスを本文に書く形になる」）。
 */
export function buildPrompt(sessionRelativeDir: string, template?: string | null, feedbackMd?: string): string {
  // 文面は設定（Settings.agentPrompt）と共通。空なら既定文（src/shared/agentPrompt.ts）。
  // 絶対パスを渡さなければ {{path}} も相対パスになる
  return renderAgentPrompt({ relativeDir: sessionRelativeDir, feedbackMd }, template)
}
