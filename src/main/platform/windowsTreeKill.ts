import { win32 } from 'node:path'

/**
 * Windows でタブを閉じるとき、シェルの子孫ごと終わらせるコマンド（純粋な関数。単体テストの対象）。
 *
 * node-pty の kill() は ConPTY を閉じるだけで、コンソールに付いていない孫（画面を出さずに起動した
 * MCP サーバ・npm run dev の node など）は残り、ポートを掴んだままたまっていく（Orca #9704 #10150）。
 * taskkill /T は親子の記録をたどるので、シェルがまだ生きているうちに呼ぶ（先にシェルが死ぬと辿れない）。
 * 素の名前で探させず、System32 の実体を絶対パスで起動する（security-4 [1]）
 */
export function windowsTreeKillCommand(pid: number, systemRoot: string | undefined): { file: string; args: string[] } | null {
  // 0 と 4（System）や負の値は触らない
  if (!Number.isInteger(pid) || pid <= 4) return null
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows'
  return { file: win32.join(root, 'System32', 'taskkill.exe'), args: ['/PID', String(pid), '/T', '/F'] }
}
