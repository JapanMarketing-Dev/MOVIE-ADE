import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { ShellSpec } from './terminal'

/**
 * Agentタブの起動。ログインシェルを普段どおり立ち上げ、最初のプロンプトが出た時点で
 * Agentの起動コマンドを「打ち込まれたもの」として実行させる。
 * Agentを終了すると、そのまま同じシェルのプロンプトへ戻る（Orcaと同じ挙動）。
 *
 * Orca由来: ~/bench/orca/src/main/shell-templates.ts（getZshShellReadyMarkerRegistrationBlock,
 *           ZSH_ZDOTDIR_HANDBACK_BLOCK, ZSH_USER_ZSHENV_SOURCE_BLOCK, getFishShellReadyInitCommand）,
 *           ~/bench/orca/src/main/zsh-startup-wrapper-builder.ts,
 *           ~/bench/orca/src/main/pty/posix-shell-startup-command.ts,
 *           ~/bench/orca/src/main/daemon/daemon-bash-shell-ready-rcfile.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * PTYへ文字列を書き込むだけだと、シェルが rc を読み終える前に届いて二重に表示されたり、
 * プロンプトのテーマが入力を消したりする。Orca は zsh / bash / fish の起動ファイルに
 * 小さなフックを差し込み、最初のプロンプトでコマンドを実行させている。ここではその仕組みから、
 * 準備完了マーカー・OSC 133・履歴の付け替えなど本システムで使わない部分を除いて移植した。
 * 対応しないシェル（sh、cmd、PowerShell など）は、出力が落ち着いたところで書き込む（terminal.ts）。
 */

/** シェルへ渡す起動コマンドの環境変数。最初のプロンプトで読んだらすぐ消す */
export const STARTUP_COMMAND_ENV = 'ADE_STARTUP_COMMAND'
const ORIG_ZDOTDIR_ENV = 'ADE_ORIG_ZDOTDIR'

/**
 * zsh 用の .zshenv。ZDOTDIR を利用者のものへすぐ返し、以降の .zprofile / .zshrc / .zlogin は
 * 普段どおり利用者の場所から読ませる。そのうえで最初の precmd で zle-line-init を差し替え、
 * 起動コマンドを入力欄（BUFFER）に入れて accept-line する。履歴にも普通のコマンドとして残る。
 *
 * 関数はすべて利用者の .zshenv を読む「前」に定義する（.zshenv が emulate sh で終わっても
 * 関数の中身は定義時に zsh として読まれているので壊れない。Orca と同じ理由）。
 */
export function zshStartupWrapper(): string {
  return `# ADE zsh startup wrapper（Orca由来。毎回作り直すので編集しないこと）
__ade_usable_zdotdir() {
  [[ -n "\${1:-}" ]] || return 1
  [[ "$1" != */ade-shell-*/zsh ]] || return 1
  return 0
}
if __ade_usable_zdotdir "\${${ORIG_ZDOTDIR_ENV}:-}"; then
  builtin export ZDOTDIR="$${ORIG_ZDOTDIR_ENV}"
else
  builtin unset ZDOTDIR
fi
builtin unset ${ORIG_ZDOTDIR_ENV}
builtin unfunction __ade_usable_zdotdir
__ade_deferred_init() {
  builtin emulate -L zsh
  builtin typeset -g precmd_functions
  precmd_functions=(\${precmd_functions:#__ade_deferred_init})
  # 利用者の zle-line-init があれば、それを呼んでから起動コマンドを入れる
  if [[ "\${widgets[zle-line-init]:-}" == "user:__ade_line_init" ]]; then
    :
  elif (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" == user:* ]]; then
    builtin typeset -g __ade_prev_line_init_fn="\${widgets[zle-line-init]#user:}"
  else
    builtin typeset -g __ade_prev_line_init_fn=""
  fi
  __ade_line_init() {
    if [[ -n "\${__ade_prev_line_init_fn:-}" ]]; then
      "\${__ade_prev_line_init_fn}" "$@"
    fi
    if (( \${+${STARTUP_COMMAND_ENV}} )); then
      BUFFER="$${STARTUP_COMMAND_ENV}"
      CURSOR=\${#BUFFER}
      builtin unset ${STARTUP_COMMAND_ENV}
      zle accept-line
    fi
  }
  zle -N zle-line-init __ade_line_init
  builtin unfunction __ade_deferred_init
}
{
  builtin typeset _ade_user_zshenv="\${ZDOTDIR-$HOME}/.zshenv"
  [[ ! -r "$_ade_user_zshenv" ]] || builtin source -- "$_ade_user_zshenv"
} always {
  builtin unset _ade_user_zshenv
  builtin typeset -ag precmd_functions
  (( \${precmd_functions[(Ie)__ade_deferred_init]} )) || precmd_functions+=(__ade_deferred_init)
}
`
}

/**
 * bash 用の rcfile。`bash --rcfile` は非ログインの対話シェルになるため、
 * ログインシェルと同じ起動ファイル（/etc/profile → ~/.bash_profile 等）を自分で読む（Orcaと同じ）。
 * 最初のプロンプトの PROMPT_COMMAND で起動コマンドを表示・履歴登録してから実行する。
 */
export function bashStartupRcfile(): string {
  return `# ADE bash startup wrapper（Orca由来。毎回作り直すので編集しないこと）
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
__ade_run_startup_command() {
  [[ \${${STARTUP_COMMAND_ENV}+present} == present ]] || return 0
  local __ade_command="$${STARTUP_COMMAND_ENV}"
  unset ${STARTUP_COMMAND_ENV}
  builtin history -s "$__ade_command" 2>/dev/null || true
  builtin printf '%s\\n' "$__ade_command"
  eval "$__ade_command"
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND+=(__ade_run_startup_command)
else
  PROMPT_COMMAND="\${PROMPT_COMMAND:+\${PROMPT_COMMAND%;}; }__ade_run_startup_command"
fi
`
}

/** fish は config.fish の後に走る --init-command で、最初の fish_prompt に一度だけ実行する */
export function fishStartupInitCommand(): string {
  return `function __ade_startup_command --on-event fish_prompt
  functions -e __ade_startup_command
  if set -q ${STARTUP_COMMAND_ENV}
    set -l __ade_command "$${STARTUP_COMMAND_ENV}"
    set -e ${STARTUP_COMMAND_ENV}
    builtin printf '%s\\n' "$__ade_command"
    eval "$__ade_command"
  end
end`
}

let wrapperRoot: string | null = null

/** 起動ファイルを一時フォルダへ書き出す（プロセスごとに1回。利用者だけが読める権限） */
function ensureWrapperRoot(): string {
  if (wrapperRoot) return wrapperRoot
  let user = 'user'
  try {
    user = userInfo().username.replace(/[^\w.-]/g, '_') || user
  } catch {
    /* 取れなければ固定名で続ける */
  }
  const root = join(tmpdir(), `ade-shell-${user}`)
  mkdirSync(join(root, 'zsh'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'zsh', '.zshenv'), zshStartupWrapper(), { mode: 0o600 })
  writeFileSync(join(root, 'bashrc'), bashStartupRcfile(), { mode: 0o600 })
  wrapperRoot = root
  return root
}

export type StartupDelivery =
  /** シェルの起動ファイルが最初のプロンプトで実行する */
  | { kind: 'shell-hook'; shell: ShellSpec; env: Record<string, string> }
  /** フックを差し込めないシェル。出力が落ち着いたらPTYへ書き込む */
  | { kind: 'write'; shell: ShellSpec; env: Record<string, string> }

/**
 * 起動コマンドを、そのシェルに合った渡し方にする。
 * 起動ファイルを書き出せないときは、書き込み方式に切り替える。
 */
export function planStartupDelivery(
  shell: ShellSpec,
  command: string,
  inheritedZdotdir: string | undefined = process.env.ZDOTDIR
): StartupDelivery {
  const name = (shell.file.split(/[\\/]/).pop() ?? shell.file).toLowerCase()
  try {
    if (name === 'zsh') {
      const root = ensureWrapperRoot()
      const env: Record<string, string> = { ZDOTDIR: join(root, 'zsh'), [STARTUP_COMMAND_ENV]: command }
      if (inheritedZdotdir) env[ORIG_ZDOTDIR_ENV] = inheritedZdotdir
      return { kind: 'shell-hook', shell, env }
    }
    if (name === 'bash') {
      const root = ensureWrapperRoot()
      return {
        kind: 'shell-hook',
        shell: { file: shell.file, args: ['--rcfile', join(root, 'bashrc'), '-i'] },
        env: { [STARTUP_COMMAND_ENV]: command }
      }
    }
    if (name === 'fish') {
      return {
        kind: 'shell-hook',
        shell: { file: shell.file, args: [...shell.args, '--init-command', fishStartupInitCommand()] },
        env: { [STARTUP_COMMAND_ENV]: command }
      }
    }
  } catch (err) {
    console.warn('[terminal] 起動ファイルを書き出せません。入力で起動します', err)
  }
  return { kind: 'write', shell, env: {} }
}
