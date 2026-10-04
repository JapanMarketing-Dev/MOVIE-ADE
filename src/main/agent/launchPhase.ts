/**
 * Agent として開いたタブで、起動時の Agent をまだ前面のプロセスとみなしてよいか（純粋な関数。単体テストの対象）。
 *
 * 段階: 何も見ていない（undefined）→ 前面にシェル以外を見た（seen）→ そのあとシェルに戻った（ended）。
 * ended になったら、以後は前面に何が動いていても起動時の Agent とはみなさない。
 * claude を終えた同じタブで dev サーバーなどを動かしたとき、そこへ指摘の本文と Enter を送らないため（Orca #6355）
 */
export type LaunchAgentPhase = 'seen' | 'ended' | undefined

export function nextLaunchAgentPhase(phase: LaunchAgentPhase, foreground: boolean): LaunchAgentPhase {
  if (foreground && !phase) return 'seen'
  if (!foreground && phase === 'seen') return 'ended'
  return phase
}
