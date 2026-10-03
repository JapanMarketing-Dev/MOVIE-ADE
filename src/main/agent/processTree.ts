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

/**
 * Windows のプロセス一覧（PowerShell の Win32_Process を「pid ⇥ ppid ⇥ Name ⇥ CommandLine」で並べたもの）を行に分ける。
 * command は「実行ファイル名＋引数」にする（CommandLine の先頭の実行ファイルは "C:\Program Files\…" のように空白を含むので、
 * そのまま空白で区切ると agentForProcess が名前を読めない）。CommandLine が読めないプロセスは Name だけ
 */
export function parseWindowsProcessRows(stdout: string): ProcessRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const [pid, parent, name = '', ...rest] = line.split('\t')
    if (!/^\d+$/.test(pid?.trim() ?? '') || !/^\d+$/.test(parent?.trim() ?? '') || !name.trim()) return []
    const commandLine = rest.join('\t').trim()
    let args = ''
    if (commandLine.startsWith('"')) {
      const end = commandLine.indexOf('"', 1)
      args = end > 0 ? commandLine.slice(end + 1) : ''
    } else if (commandLine) {
      const space = commandLine.search(/\s/)
      args = space > 0 ? commandLine.slice(space) : ''
    }
    return [{ pid: Number(pid), parent: Number(parent), command: `${name.trim()} ${args.trim()}`.trim() }]
  })
}

/** ConPTY がシェルの横に置くコンソールのホスト。前面のプロセスには数えない */
const CONSOLE_HOSTS = new Set(['conhost', 'openconsole'])

/**
 * Windows で、シェル（shellPid）の子に何か動いているか（プロンプトに戻っていなければ true）。
 * node-pty の Windows 版の pty.process は端末名（xterm-256color）を返すだけで前面のプロセスを表さないので、子の有無で見る
 */
export function hasForegroundChild(rows: readonly ProcessRow[], shellPid: number): boolean {
  return rows.some((row) => {
    if (row.parent !== shellPid) return false
    const base = (row.command.split(/\s/)[0] ?? '').toLowerCase().replace(/\.exe$/, '')
    return !CONSOLE_HOSTS.has(base)
  })
}
