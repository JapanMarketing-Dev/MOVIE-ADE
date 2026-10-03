/**
 * 親のエージェント（Claude Code / Codex）のセッションを示す環境変数を、子へ渡さないための一覧。
 *
 * Orca由来の考え方: ~/bench/orca/src/main/pty/pi-process-owner-env.ts（「新しいターミナルは、ホストを
 * 起動したペインの子エージェントではない」）, ~/bench/orca/src/main/pty/terminal-color-env.ts
 * （親だけの選択を端末に持ち込まない）（MIT, Copyright 2026 Lovecast Inc.）
 *
 * dev 版を Claude Code の中から起動すると、CLAUDECODE や CLAUDE_CODE_SESSION_ID などが MOVIE-ADE に受け継がれ、
 * そのまま内蔵ターミナルや「指摘の整理」の CLI に渡る。すると子の Claude Code は自分を親のセッションの
 * 子だと見なし、「Transcript saving is off — inherited CLAUDE…」のように振る舞いを変える。
 *
 * 消すのはセッションの識別・通信・実行場所を表すものだけにする。利用者の設定（CLAUDE_CONFIG_DIR、
 * CODEX_HOME、CLAUDE_CODE_USE_BEDROCK、モデルの指定など）は残す。アカウント切り替えは CLAUDE_CONFIG_DIR /
 * CODEX_HOME で行うので、ここで消すとアカウントが効かなくなる。
 */

/** 名前がそのまま一致したら消すもの */
export const INHERITED_AGENT_SESSION_ENV_KEYS: readonly string[] = [
  // Claude Code が自分の子プロセス（Bash ツールなど）に付けるもの
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_AGENT_SDK_VERSION',
  // エージェントの中で動いていることを外部ツールに知らせる印（Claude Code が付ける）
  'AI_AGENT',
  // Codex が自分の子プロセスに付けるもの（CODEX_HOME などの設定は消さない）
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_BY_BUN',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
]

/** この接頭辞で始まるものは消す（セッション ID・同席の有無・親とのメッセージ通信） */
export const INHERITED_AGENT_SESSION_ENV_PREFIXES: readonly string[] = ['CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_MESSAGING_']

/** 親のエージェントのセッションを示す変数か */
export function isInheritedAgentSessionEnv(name: string, value?: string): boolean {
  if (INHERITED_AGENT_SESSION_ENV_KEYS.includes(name)) return true
  if (INHERITED_AGENT_SESSION_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
  // Claude Code は編集エディタを開かせないよう GIT_EDITOR=true を付ける。端末で git commit が
  // 何も書かずに終わってしまうので、この値のときだけ消す（利用者が設定したエディタは残す）
  if (name === 'GIT_EDITOR' && value === 'true') return true
  return false
}

/** 親のエージェントのセッションを示す変数を除いた環境変数を返す（元は変えない） */
export function stripInheritedAgentSessionEnv<T extends Record<string, string | undefined>>(env: T): T {
  const next = {} as Record<string, string | undefined>
  for (const [name, value] of Object.entries(env)) {
    if (!isInheritedAgentSessionEnv(name, value)) next[name] = value
  }
  return next as T
}
