/**
 * Codex のセキュリティ監査（全体のダッシュボードのボタン）。Codex を Daybreak Blue・Extra high で開き、
 * 依頼文（組み込みの依頼 security-codex）を渡す。依頼文は長いので全体のフォルダのファイルに書き、
 * 起動の引数ではそのファイルを読むよう短く頼む。renderer は起動の名前（preset）だけを渡し、引数は main がここから作る
 */

export const CODEX_AUDIT_PRESET = 'codex-security-audit'
export type TerminalPreset = typeof CODEX_AUDIT_PRESET

export const CODEX_AUDIT_MODEL = 'gpt-daybreak-blue-latest'
export const CODEX_AUDIT_EFFORT = 'xhigh'
/** 依頼文の置き場所（全体のフォルダから） */
export const CODEX_AUDIT_FILE = '.ferret/requests/codex-security-audit.md'

export function isTerminalPreset(value: unknown): value is TerminalPreset {
  return value === CODEX_AUDIT_PRESET
}

/** codex の起動の引数に足すもの（モデル・考える深さ・最初の依頼） */
export function codexAuditArgs(lang: 'ja' | 'en'): string[] {
  const prompt = lang === 'ja'
    ? `${CODEX_AUDIT_FILE} を読み、書かれている依頼をそのとおりに実行してください。`
    : `Read ${CODEX_AUDIT_FILE} and carry out the request in it exactly.`
  return ['-m', CODEX_AUDIT_MODEL, '-c', `model_reasoning_effort="${CODEX_AUDIT_EFFORT}"`, prompt]
}
