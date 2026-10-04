import { execFile } from 'node:child_process'
import { errorKind, reportHandled } from '@shared/report'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  BUILTIN_AGENTS,
  AGENT_CATALOG,
  agentLabel,
  defaultLaunchConfig,
  detectCommandsFor,
  findCustomAgent,
  isBuiltinAgent
} from '@shared/agentCatalog'
import type { AgentOption, AgentPreferences, TuiAgent } from '@shared/types'

/**
 * インストールされているエージェントの検出（「＋」メニューに出すもの・設定画面の印）。
 *
 * Orca由来: ~/bench/orca/src/main/preflight/agent-detection.ts（detectInstalledAgents）,
 *           ~/bench/orca/src/main/ipc/preflight-command-exec.ts（isCommandOnPath）,
 *           ~/bench/orca/src/shared/tui-agent-detection-commands.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく、コマンドごとにプロセスを起動して which を呼ぶのではなく、PATH の各フォルダを fs で見る。
 * Finder から起動した Electron は PATH が短い（nvm や Homebrew が入らない）ので、ログインシェルの PATH を
 * 一度だけ取り、よく使うインストール先も足す（Orca の hydrateShellPath / install-dir 検出に相当）。
 */

/** ログインシェルの PATH を待つ上限。シェルの設定が重くても検出全体を止めない */
const SHELL_PATH_TIMEOUT_MS = 3000
/** 検出結果を覚えておく時間。メニューを開くたびに探し直さない */
const CACHE_TTL_MS = 30_000

/** PATH に入っていないことが多いインストール先（npm -g、bun、pipx、cargo、Homebrew、Cursor のインストーラ） */
function extraInstallDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.amp', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
}

let shellPathPromise: Promise<string> | null = null
/** 取れなかった時刻。重い rc で毎回待たせないよう、取り直すのは1分あけてから */
let shellPathFailedAt = 0
let shellPathReported = false
const SHELL_PATH_RETRY_MS = 60_000

/** ログインシェルが持つ PATH（取れなければ空） */
function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('')
  if (!shellPathPromise && Date.now() - shellPathFailedAt < SHELL_PATH_RETRY_MS) return Promise.resolve('')
  shellPathPromise ??= new Promise<string>((resolve) => {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    execFile(shell, ['-ilc', 'printf "__ADE_PATH__%s" "$PATH"'], { timeout: SHELL_PATH_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      const marker = error ? -1 : stdout.lastIndexOf('__ADE_PATH__')
      if (marker < 0) {
        // 取れなかった（rc が重くて時間切れ・nushell など）。失敗を使い回さず、次に探すときに取り直す。
        // 使い回すと、ログインシェルの PATH にだけある Agent が＋メニューから消えたままになる（Orca #16340）
        shellPathPromise = null
        shellPathFailedAt = Date.now()
        if (!shellPathReported) {
          shellPathReported = true
          reportHandled(error ? errorKind(error) : new Error('login shell PATH marker missing'), { area: 'agent-launch', op: 'read login shell PATH' })
        }
        return resolve('')
      }
      resolve(stdout.slice(marker + '__ADE_PATH__'.length).trim())
    })
  })
  return shellPathPromise
}

/** 探すフォルダ（重なりは除く） */
export async function searchDirs(): Promise<string[]> {
  const fromShell = await loginShellPath()
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...fromShell.split(':'), ...extraInstallDirs()]
  return [...new Set(dirs.filter(Boolean))]
}

/** dirs のどこかに実行できる command があるか（Windows は PATHEXT の拡張子も試す） */
export function isCommandInDirs(command: string, dirs: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  if (!command || /[\\/]/.test(command)) {
    // 絶対パス・相対パスはそのまま確かめる
    return command ? isExecutable(command, platform) : false
  }
  const exts = platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.PS1').toLowerCase().split(';')] : ['']
  return dirs.some((dir) => exts.some((ext) => isExecutable(join(dir, command + ext), platform)))
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    // 無い・実行できない候補（想定内）
    return false
  }
}

let cache: { at: number; checked: Set<string>; found: Set<string> } | null = null

/** 検出対象のコマンドのうち、見つかったもの */
async function foundCommands(commands: readonly string[], refresh: boolean): Promise<Set<string>> {
  const current = cache
  if (!refresh && current && Date.now() - current.at < CACHE_TTL_MS && commands.every((c) => current.checked.has(c))) {
    return current.found
  }
  const dirs = await searchDirs()
  const found = new Set(commands.filter((command) => isCommandInDirs(command, dirs)))
  cache = { at: Date.now(), checked: new Set(commands), found }
  return found
}

/** 設定と検出結果を合わせた一覧（組み込み → カスタムの順） */
export async function listAgentOptions(prefs: AgentPreferences, refresh = false): Promise<AgentOption[]> {
  const ids: TuiAgent[] = [...BUILTIN_AGENTS, ...prefs.customAgents.map((custom) => custom.id)]
  const found = await foundCommands([...new Set(ids.flatMap((id) => detectCommandsFor(id, prefs)))], refresh)
  const disabled = new Set(prefs.disabledAgents)
  return ids.map((id): AgentOption => {
    const installed = detectCommandsFor(id, prefs).some((command) => found.has(command))
    if (isBuiltinAgent(id)) {
      const launch = prefs.launch[id] ?? defaultLaunchConfig(id)
      const fallback = defaultLaunchConfig(id)
      return {
        id,
        label: agentLabel(id),
        custom: false,
        installed,
        enabled: !disabled.has(id),
        command: launch.command,
        args: launch.args,
        defaultCommand: fallback.command,
        defaultArgs: fallback.args,
        homepageUrl: AGENT_CATALOG[id].homepageUrl
      }
    }
    const custom = findCustomAgent(prefs, id)
    return {
      id,
      label: agentLabel(id, prefs),
      custom: true,
      installed,
      enabled: !disabled.has(id),
      command: custom?.command ?? '',
      args: custom?.args ?? '',
      defaultCommand: null,
      defaultArgs: null,
      homepageUrl: null,
      ...(custom?.icon ? { icon: custom.icon } : {})
    }
  })
}
