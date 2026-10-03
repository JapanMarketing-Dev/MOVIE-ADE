/**
 * ターミナルの中で動いている Agent を、プロセスの木から同定する（純粋な処理。ps の結果は terminal.ts が渡す）。
 *
 * 前面プロセス名だけでは決められないことがある:
 * - npm 版の Claude Code / Codex は node が前面に出る
 * - 公式インストーラの Claude Code は版番号（2.1.288）が前面に出る
 * そこでシェルの子から1段ずつ下へ見て、最初に Agent と分かった段で決める。
 * 子孫を全部まとめて見ると、Claude Code が MCP サーバーとして起動した codex などの孫まで数えてしまい、
 * 「Agent が2種類いる」として同定をあきらめていた（起動中の Claude Code に送れなかった）。
 */
import type { TuiAgent } from '@shared/types'

export interface ProcessRow {
  pid: number
  parent: number
  command: string
}

/** ps -axo pid=,ppid=,args= の出力を行に分ける */
export function parseProcessRows(stdout: string): ProcessRow[] {
  return stdout.split('\n').flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: m[3]! }] : []
  })
}

/** rootPid（シェル）の子から順に、最初に Agent と分かった段の Agent。同じ段に2種類いれば決めない */
export function agentInProcessTree(rows: readonly ProcessRow[], rootPid: number, identify: (command: string) => TuiAgent | null, maxDepth = 8): TuiAgent | null {
  let level = new Set([rootPid])
  const seen = new Set([rootPid])
  for (let depth = 0; depth < maxDepth && level.size > 0; depth++) {
    const children = rows.filter((row) => level.has(row.parent) && !seen.has(row.pid))
    const found = new Set(children.flatMap((row) => identify(row.command) ?? []))
    if (found.size === 1) return [...found][0]!
    if (found.size > 1) return null
    for (const row of children) seen.add(row.pid)
    level = new Set(children.map((row) => row.pid))
  }
  return null
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell', 'cmd', 'login'])

/** 前面がシェルそのもの（プロンプトに戻っている）か。`-zsh` のようなログインシェルの名前も含む */
export function isShellProcess(name: string): boolean {
  const base = (name.trim().split(/[\\/]/).pop() ?? '').toLowerCase().replace(/^-/, '').replace(/\.exe$/, '')
  return base === '' || SHELLS.has(base)
}
