/**
 * 親のエージェント（Claude Code / Codex）のセッションの環境変数を、内蔵ターミナルと「指摘の整理」の子に渡さない。
 */
import { describe, expect, it } from 'vitest'
import { isInheritedAgentSessionEnv } from '../../src/main/inheritedAgentEnv'
import { childEnv } from '../../src/main/pipeline/organize/runners/claudeCode'

/** Claude Code の中から dev 版を起動したときに実際に受け継がれていたもの（値は伏せた） */
const fromClaudeCode = {
  CLAUDECODE: '1',
  CLAUDE_PID: '23750',
  CLAUDE_EFFORT: 'medium',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/Users/me/.local/share/claude/versions/x',
  CLAUDE_CODE_SSE_PORT: '12345',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'e59d2ab8',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  AI_AGENT: 'claude-code_2-1-288_agent',
  GIT_EDITOR: 'true'
}

const fromCodex = {
  CODEX_SANDBOX: 'seatbelt',
  CODEX_SANDBOX_NETWORK_DISABLED: '1',
  CODEX_THREAD_ID: 't-1',
  CODEX_MANAGED_BY_NPM: '1'
}

/** 利用者の設定。消してはいけない */
const userConfig = {
  PATH: '/usr/bin',
  HOME: '/Users/me',
  CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
  CODEX_HOME: '/Users/me/.codex-work',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
  ANTHROPIC_MODEL: 'claude-opus-5',
  CODEX_API_KEY_FILE: '/x'
}

describe('isInheritedAgentSessionEnv', () => {
  it('GIT_EDITOR は Claude Code が付ける true のときだけ消す', () => {
    expect(isInheritedAgentSessionEnv('GIT_EDITOR', 'true')).toBe(true)
    expect(isInheritedAgentSessionEnv('GIT_EDITOR', 'vim')).toBe(false)
  })

  it('アカウント切り替えの変数は消さない', () => {
    expect(isInheritedAgentSessionEnv('CLAUDE_CONFIG_DIR', '/x')).toBe(false)
    expect(isInheritedAgentSessionEnv('CODEX_HOME', '/x')).toBe(false)
  })
})

describe('「指摘の整理」の子プロセス', () => {
  it('親のセッションの印は渡さず、CLAUDE_CONFIG_DIR / CODEX_HOME は残す', () => {
    const env = childEnv({ ...fromClaudeCode, ...fromCodex, PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h' })
    expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h' })
  })
})
