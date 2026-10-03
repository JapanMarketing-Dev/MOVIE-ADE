/**
 * エージェントが40種以上あるときの並べ方・たたみ方・検索（オンボーディングと設定の Agents 節）と、
 * カタログ外のエージェントのタイトルからの状態判定（Orca の agent-title-core 移植）。
 */
import { describe, expect, it } from 'vitest'
import type { AgentOption, TuiAgent } from '@shared/types'
import { listAgents, matchesAgentQuery } from '../../src/renderer/lib/agentListing'
import { detectGenericTitleState } from '../../src/main/agent/state'

function option(id: TuiAgent, label: string, extra: Partial<AgentOption> = {}): AgentOption {
  return {
    id,
    label,
    custom: id.startsWith('custom:'),
    installed: false,
    enabled: true,
    command: id,
    args: '',
    defaultCommand: null,
    defaultArgs: null,
    homepageUrl: null,
    ...extra
  }
}

// カタログの順（主要なもの → 残り）→ カスタム、で渡される
const options: AgentOption[] = [
  option('claude', 'Claude Code', { installed: true }),
  option('codex', 'Codex'),
  option('devin', 'Devin'),
  option('cursor', 'Cursor CLI', { command: 'agent' }),
  option('aider', 'Aider'),
  option('goose', 'Goose', { installed: true }),
  option('zcode', 'ZCode'),
  option('custom:my-agent', 'My Agent')
]

describe('listAgents', () => {
  it('見つかったもの → 主要なもの → 残りの順。同じ順位の中は渡された順', () => {
    const { visible } = listAgents(options, { showAll: true })
    expect(visible.map((o) => o.id)).toEqual(['claude', 'goose', 'codex', 'devin', 'cursor', 'aider', 'zcode', 'custom:my-agent'])
  })

  it('普段は残りをたたみ、たたんだ数を返す。カスタムと選んでいるものは常に見せる', () => {
    const { visible, hiddenCount } = listAgents(options, { selected: ['zcode'] })
    expect(visible.map((o) => o.id)).toEqual(['claude', 'goose', 'codex', 'devin', 'cursor', 'zcode', 'custom:my-agent'])
    expect(hiddenCount).toBe(1)
    expect(listAgents(options).hiddenCount).toBe(2)
  })

  it('検索中はたたんだものも含めて絞り込み、たたみ数は 0', () => {
    expect(listAgents(options, { query: 'aid' })).toEqual({ visible: [options[4]], hiddenCount: 0 })
    expect(listAgents(options, { query: 'nothing-matches' }).visible).toEqual([])
    // 空白だけなら検索しない
    expect(listAgents(options, { query: '   ' }).hiddenCount).toBe(2)
  })
})

describe('matchesAgentQuery', () => {
  it('名前・id・コマンド・カタログの検出コマンドと別名で、大文字小文字を問わず、語をすべて含めば一致', () => {
    expect(matchesAgentQuery(options[2]!, 'DEVIN')).toBe(true)
    // Cursor は旧名 cursor-agent でも見つかる
    expect(matchesAgentQuery(options[3]!, 'cursor-agent')).toBe(true)
    expect(matchesAgentQuery(options[3]!, 'cursor cli')).toBe(true)
    expect(matchesAgentQuery(options[3]!, 'cursor devin')).toBe(false)
    expect(matchesAgentQuery(options[7]!, 'my')).toBe(true)
    expect(matchesAgentQuery(options[0]!, '')).toBe(true)
  })
})

describe('detectGenericTitleState（カタログ外のエージェントのタイトル）', () => {
  it('記号・スピナー・単独の語から判定し、パスの中の語は数えない', () => {
    expect(detectGenericTitleState('✋ Gemini')).toBe('blocked')
    expect(detectGenericTitleState('✦ Gemini')).toBe('working')
    expect(detectGenericTitleState('⠋ droid')).toBe('working')
    expect(detectGenericTitleState('kimi - Thinking')).toBe('working')
    expect(detectGenericTitleState('◇ Ready')).toBe('idle')
    expect(detectGenericTitleState('agent: done')).toBe('idle')
    expect(detectGenericTitleState('~/work/ready')).toBe('unknown')
    expect(detectGenericTitleState('zsh')).toBe('unknown')
    expect(detectGenericTitleState('')).toBe('unknown')
    expect(detectGenericTitleState(undefined)).toBe('unknown')
  })
})
