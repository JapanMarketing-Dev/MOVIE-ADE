import { describe, expect, it } from 'vitest'
import { LLM_PROVIDER_PRESETS } from '@shared/aiProviders'
import { CLAUDE_CODE_ORGANIZE_DEFAULT_MODEL, organizeModelChoice, organizeModelPatch, organizeRunnerSummary } from '@shared/organizeModels'

describe('整理のモデルの一覧', () => {
  it('API の提供元は設定と同じ推奨の一覧で、何も設定していなければ推奨を使う', () => {
    const c = organizeModelChoice('api:openai', undefined)
    expect(c.current).toBe(LLM_PROVIDER_PRESETS.openai.model)
    expect(c.defaultModel).toBe(LLM_PROVIDER_PRESETS.openai.model)
    expect(c.options.map((o) => o.id)).toEqual(LLM_PROVIDER_PRESETS.openai.models.map((m) => m.id))
    expect(c.options.filter((o) => o.recommended).map((o) => o.id)).toEqual([LLM_PROVIDER_PRESETS.openai.model])
    expect(c.otherInSettings).toBe(true)
  })

  it('Ollama はこの PC に合うモデルを推奨にし、一覧に無ければ先頭に足す', () => {
    const c = organizeModelChoice('api:ollama', {}, 'qwen3:8b')
    expect(c.current).toBe('qwen3:8b')
    expect(c.options.find((o) => o.recommended)?.id).toBe('qwen3:8b')
    const unknown = organizeModelChoice('api:ollama', {}, 'qwen3:14b')
    expect(unknown.options[0]).toEqual({ id: 'qwen3:14b', recommended: true })
  })

  it('設定で入れた一覧に無いモデルも選択肢に出す', () => {
    const c = organizeModelChoice('api:ollama', { endpoints: { ollama: { model: 'my-model:7b' } } }, 'gpt-oss:20b')
    expect(c.current).toBe('my-model:7b')
    expect(c.options.map((o) => o.id)).toContain('my-model:7b')
    expect(c.options.filter((o) => o.id === 'my-model:7b')).toHaveLength(1)
  })

  it('LM Studio はモデルを入れていなければ未設定（設定で入れる）', () => {
    const c = organizeModelChoice('api:lmstudio', undefined)
    expect(c.current).toBe('')
    expect(c.options).toEqual([])
    expect(c.otherInSettings).toBe(true)
  })

  it('Claude Code は --model の別名で、既定は haiku', () => {
    const c = organizeModelChoice('claude-code', undefined)
    expect(c.current).toBe(CLAUDE_CODE_ORGANIZE_DEFAULT_MODEL)
    expect(c.options.map((o) => o.id)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(c.otherInSettings).toBe(false)
    expect(organizeModelChoice('claude-code', { cliModels: { 'claude-code': 'opus' } }).current).toBe('opus')
  })

  it('Codex は CLI の既定（モデルを渡さない）と、設定したモデル', () => {
    expect(organizeModelChoice('codex', undefined)).toMatchObject({ current: '', options: [{ id: '', recommended: true }] })
    const c = organizeModelChoice('codex', { cliModels: { codex: 'gpt-6.1-sol' } })
    expect(c.current).toBe('gpt-6.1-sol')
    expect(c.options.map((o) => o.id)).toEqual(['', 'gpt-6.1-sol'])
  })
})

describe('選んだモデルを書く差分', () => {
  it('API はその提供元の model だけを変え、ほかの欄と提供元は残す', () => {
    const prefs = { endpoints: { openai: { timeoutMs: 5000, apiKeyEnv: 'OPENAI_API_KEY' }, anthropic: { model: 'claude-opus-5-5' } } }
    const patch = organizeModelPatch('api:openai', prefs, 'gpt-6-luna', LLM_PROVIDER_PRESETS.openai.model)
    expect(patch).toEqual({ endpoints: { openai: { timeoutMs: 5000, apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-6-luna' }, anthropic: { model: 'claude-opus-5-5' } } })
    // 元の設定は書き換えない
    expect(prefs.endpoints.openai).toEqual({ timeoutMs: 5000, apiKeyEnv: 'OPENAI_API_KEY' })
  })

  it('既定のモデルに戻したら上書きを消す（Ollama は PC に合う推奨へ戻る）', () => {
    expect(organizeModelPatch('api:ollama', { endpoints: { ollama: { model: 'qwen3:8b' } } }, 'gpt-oss:20b', 'gpt-oss:20b')).toEqual({ endpoints: {} })
    expect(organizeModelPatch('api:ollama', { endpoints: { ollama: { model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434/v1' } } }, 'gpt-oss:20b', 'gpt-oss:20b'))
      .toEqual({ endpoints: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1' } } })
  })

  it('CLI は cliModels に書き、既定なら消す', () => {
    expect(organizeModelPatch('claude-code', undefined, 'sonnet', 'haiku')).toEqual({ cliModels: { 'claude-code': 'sonnet' } })
    expect(organizeModelPatch('claude-code', { cliModels: { 'claude-code': 'sonnet', codex: 'x' } }, 'haiku', 'haiku')).toEqual({ cliModels: { codex: 'x' } })
    expect(organizeModelPatch('codex', { cliModels: { codex: 'x' } }, '', '')).toEqual({ cliModels: undefined })
  })
})

describe('提供元とモデルの1行の名前', () => {
  it('モデルがあれば「提供元 · モデル」、無ければ提供元だけ', () => {
    expect(organizeRunnerSummary('Ollama', 'gpt-oss:20b')).toBe('Ollama · gpt-oss:20b')
    expect(organizeRunnerSummary('Codex', '')).toBe('Codex')
  })
})
