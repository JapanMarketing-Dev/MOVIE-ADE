/**
 * 「Agentへ送信」の宛先を決める（純粋な処理。terminal.ts が候補を集めて渡す）。
 *
 * 画面でフォーカスしているターミナルに Agent が居ればそこへ送る。居なければ（素のシェルを選んでいた・
 * Agent が終了してシェルに戻った など）、同じプロジェクトで動いている Agent のターミナルへ送る。
 * Claude Code → Codex → そのほか の順、同じ種類なら待機中を先にする。確認待ち（blocked）は最後。
 * どこにも居なければ null（renderer が既定の Agent を起動してから送り直す）。
 */
import type { AgentKind } from './protocol'
import { isInsideDir } from '@shared/sendTarget'

export interface SendCandidate {
  id: string
  /** そのターミナルを開いたフォルダ */
  cwd: string
  kind: AgentKind
  state: string
}

const KIND_ORDER: Record<AgentKind, number> = { 'claude-code': 0, codex: 1, generic: 2, unknown: 9 }
const STATE_ORDER: Record<string, number> = { idle: 0, working: 1, unknown: 2, blocked: 3 }


export function chooseSendTarget(preferred: string | null, candidates: readonly SendCandidate[], projectDir: string | null): string | null {
  const current = candidates.find((c) => c.id === preferred)
  if (current && current.kind !== 'unknown') return current.id
  const ranked = candidates
    .filter((c) => c.kind !== 'unknown' && (!projectDir || isInsideDir(c.cwd, projectDir)))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (STATE_ORDER[a.state] ?? 2) - (STATE_ORDER[b.state] ?? 2))
  return ranked[0]?.id ?? null
}
