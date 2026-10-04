/**
 * 設定の簡単な経路（提供元 → モデル → キー。ほかは「詳細」）のテスト。
 * プリセットの表（推奨のモデル・確かめた日）と、出し方の判定、実際の描画（静的な HTML）を確かめる。
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AI_PRESETS_VERIFIED_AT,
  LLM_API_PROVIDERS,
  LLM_PROVIDER_PRESETS,
  STT_PROVIDER_PRESETS,
  STT_REMOTE_PROVIDERS,
  currentModel,
  isEndpointReady,
  recommendedModel,
  selectModel,
  setupLayout,
  transcriptionLayout,
  type AiEndpointConfig,
} from '@shared/aiProviders'
import { translate } from '@shared/i18n'
import type { SttAvailability } from '@shared/types'

// 画面の言語のフック（useSyncExternalStore）はサーバー描画で使えないので、英語の t に差し替える
vi.mock('../../src/renderer/lib/i18n', () => ({
  useT: () => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params),
}))

const ALL = [...STT_REMOTE_PROVIDERS.map((p) => STT_PROVIDER_PRESETS[p]), ...LLM_API_PROVIDERS.map((p) => LLM_PROVIDER_PRESETS[p])]

describe('プリセットの表', () => {
  it('モデルの一覧がある提供元には推奨がちょうど1つあり、既定のモデル名と一致する', () => {
    for (const preset of ALL.filter((p) => p.models.length > 0)) {
      const rec = preset.models.filter((m) => m.recommended)
      expect(rec, preset.id).toHaveLength(1)
      expect(preset.model, preset.id).toBe(rec[0]!.id)
      expect(recommendedModel(preset)).toBe(rec[0]!.id)
      // 同じモデルが二重に載っていない
      expect(new Set(preset.models.map((m) => m.id)).size, preset.id).toBe(preset.models.length)
    }
  })

  it('一覧の無い提供元は、Base URL を入れるか端末内のサーバー（自由入力のモデル）', () => {
    for (const preset of ALL.filter((p) => p.models.length === 0)) {
      expect(preset.needsBaseUrl === true || preset.local === true, preset.id).toBe(true)
    }
  })

  it('確かめた日を持ち、キーの要る提供元（Custom・Azure 以外）には「キーを取得」の https のページがある', () => {
    expect(AI_PRESETS_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const preset of ALL.filter((p) => p.keyRequired)) {
      expect(preset.keyUrl, preset.id).toMatch(/^https:\/\//)
    }
  })

  it('端末内では文字起こしを提供しない Ollama・LM Studio は、文字起こしの選択肢に無い', () => {
    expect(STT_REMOTE_PROVIDERS).not.toContain('ollama')
    expect(STT_REMOTE_PROVIDERS).not.toContain('lmstudio')
    expect(LLM_API_PROVIDERS).toEqual(expect.arrayContaining(['ollama', 'lmstudio', 'vercel-gateway', 'cloudflare']))
    // Custom はどちらも最後
    expect(STT_REMOTE_PROVIDERS.at(-1)).toBe('compatible')
    expect(LLM_API_PROVIDERS.at(-1)).toBe('compatible')
  })
})

describe('モデルの選択', () => {
  it('提供元を切り替えると、その提供元の推奨に戻る（前の提供元で選んだモデルを持ち越さない）', () => {
    const endpoints: Partial<Record<string, AiEndpointConfig>> = { groq: { model: 'whisper-large-v3' } }
    expect(currentModel(STT_PROVIDER_PRESETS.groq, endpoints.groq)).toBe('whisper-large-v3')
    expect(currentModel(STT_PROVIDER_PRESETS.openai, endpoints.openai)).toBe('gpt-transcribe')
    expect(currentModel(LLM_PROVIDER_PRESETS.anthropic, undefined)).toBe('claude-sonnet-5-5')
  })

  it('推奨を選ぶと上書きを消し、ほかを選ぶと書く。詳細の値（Base URL・ヘッダー・タイムアウト）は消さない', () => {
    const preset = STT_PROVIDER_PRESETS.openai
    const hidden: AiEndpointConfig = { baseUrl: 'https://proxy.example/v1', timeoutMs: 30_000, headers: { 'X-Team': 'ade' }, apiKeyEnv: 'MY_KEY' }
    const picked = selectModel(preset, hidden, 'gpt-4o-transcribe')
    expect(picked).toEqual({ ...hidden, model: 'gpt-4o-transcribe' })
    const back = selectModel(preset, picked, 'gpt-transcribe')
    expect(back).toEqual(hidden)
    expect(selectModel(preset, { model: 'whisper-1' }, 'gpt-transcribe')).toBeUndefined()
  })

  it('提供元を行き来しても、提供元ごとの詳細の値は残る', () => {
    let endpoints: Partial<Record<string, AiEndpointConfig>> = { groq: { headers: { 'X-A': '1' } } }
    // OpenAI でモデルを選び、Groq へ戻る
    endpoints = { ...endpoints, openai: selectModel(STT_PROVIDER_PRESETS.openai, endpoints.openai, 'whisper-1') }
    expect(endpoints.groq).toEqual({ headers: { 'X-A': '1' } })
    expect(currentModel(STT_PROVIDER_PRESETS.groq, endpoints.groq)).toBe('whisper-large-v3-turbo')
    expect(currentModel(STT_PROVIDER_PRESETS.openai, endpoints.openai)).toBe('whisper-1')
  })

  it('端末内のサーバーは、推奨を選んでも「使う」印として残し、選ぶまでは使える数に入れない', () => {
    const ollama = LLM_PROVIDER_PRESETS.ollama
    expect(isEndpointReady(ollama, undefined, false)).toBe(false)
    const chosen = selectModel(ollama, undefined, 'gpt-oss:20b')
    expect(chosen).toEqual({ model: 'gpt-oss:20b' })
    expect(isEndpointReady(ollama, chosen, false)).toBe(true)
  })
})

describe('出し方', () => {
  it('詳細は設定画面だけで描き、オンボーディングでは描かない。言語もオンボーディングでは出さない', () => {
    expect(setupLayout(STT_PROVIDER_PRESETS.openai, { onboarding: false }).advanced).toBe(true)
    expect(setupLayout(STT_PROVIDER_PRESETS.openai, { onboarding: true }).advanced).toBe(false)
    expect(transcriptionLayout('openai', { onboarding: true }).language).toBe(false)
    expect(transcriptionLayout('openai', { onboarding: false }).language).toBe(true)
  })

  it('一覧のある提供元はモデルを選ぶだけで、Base URL を外に出さない', () => {
    expect(setupLayout(STT_PROVIDER_PRESETS.groq, { onboarding: false })).toMatchObject({ modelField: 'select', baseUrlField: false, keyField: true })
  })

  it('Custom は Base URL とモデル名の入力欄を外に出す（Azure も Base URL は外）。Cloudflare は Base URL の代わりに Account ID', () => {
    expect(setupLayout(STT_PROVIDER_PRESETS.compatible, { onboarding: false })).toMatchObject({ modelField: 'text', baseUrlField: true, accountIdField: false })
    expect(setupLayout(LLM_PROVIDER_PRESETS.compatible, { onboarding: true })).toMatchObject({ modelField: 'text', baseUrlField: true })
    expect(setupLayout(STT_PROVIDER_PRESETS.azure, { onboarding: false })).toMatchObject({ modelField: 'text', baseUrlField: true })
    expect(setupLayout(STT_PROVIDER_PRESETS.cloudflare, { onboarding: false })).toMatchObject({ modelField: 'select', baseUrlField: false, accountIdField: true })
    expect(LLM_PROVIDER_PRESETS.cloudflare.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1')
  })

  it('端末内の whisper はキーの代わりに推奨モデルのダウンロード、端末内のサーバーはキーの欄を出さない', () => {
    expect(transcriptionLayout('local', { onboarding: true })).toEqual({ language: false, downloadModel: true, setup: null })
    expect(setupLayout(LLM_PROVIDER_PRESETS.ollama, { onboarding: false }).keyField).toBe(false)
    expect(setupLayout(LLM_PROVIDER_PRESETS.lmstudio, { onboarding: false })).toMatchObject({ keyField: false, modelField: 'text' })
  })
})

// 最初のテストが画面の部品を読み込む。Windows ARM の VM は、Mac 側でビルドや E2E が動いていると 10 秒を超えた
describe('描画（静的な HTML）', { timeout: 60_000 }, () => {
  const available: SttAvailability = { localReady: false, keyStorage: 'dev', keys: {} as SttAvailability['keys'], stt: {} as SttAvailability['stt'], llm: {} as SttAvailability['llm'] }
  // 型を追わせない（テストの tsconfig は renderer を含まないため）
  const modulePath = '../../src/renderer/components/AiProviderFields'
  const render = async (props: Record<string, unknown>) => {
    const { ProviderSetup } = await import(/* @vite-ignore */ modulePath) as { ProviderSetup: (p: unknown) => unknown }
    return renderToStaticMarkup(createElement(ProviderSetup as never, { value: undefined, onChange: () => undefined, available, onAvailabilityChange: () => undefined,
      onCheck: async () => ({ ok: true, message: '' }), disabled: false, ...props }))
  }

  it('設定画面: モデルは推奨を選んだ一覧、キーの欄と「キーを作る ↗」、詳細は閉じている', async () => {
    const html = await render({ preset: STT_PROVIDER_PRESETS.openai })
    expect(html).toContain('data-testid="ai-model"')
    expect(html).toMatch(/<option value="gpt-transcribe" selected="">gpt-transcribe — balanced speed and quality · \$0\.0045\/min · Recommended<\/option>/)
    expect(html).toContain('data-testid="ai-key"')
    // キーを作るページは外部のブラウザで開くボタン（app:openExternal）。リンクの先は title に出す
    expect(html).toMatch(/data-testid="ai-link-key" title="https:\/\/platform\.openai\.com\/api-keys"/)
    expect(html).not.toContain('target="_blank"')
    expect(html).toMatch(/<details class="st-key st-advanced" data-testid="ai-advanced">/)
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    // Base URL とモデル名の自由入力は、詳細の外には無い
    expect(html).not.toContain('data-testid="ai-base-url"')
    expect(html).not.toContain('data-testid="ai-model-text"')
  })

  it('オンボーディング: 詳細を描かず、設定画面・settings.json への1行だけ', async () => {
    const html = await render({ preset: STT_PROVIDER_PRESETS.openai, onboarding: true })
    expect(html).not.toContain('ai-advanced')
    expect(html).toContain('data-testid="ai-more-options"')
    expect(html).toContain('More options in Settings or settings.json.')
  })

  it('Custom: Base URL とモデル名の入力欄を出す', async () => {
    const html = await render({ preset: STT_PROVIDER_PRESETS.compatible, onboarding: true })
    expect(html).toContain('data-testid="ai-base-url"')
    expect(html).toContain('data-testid="ai-model-text"')
  })

  it('端末内のサーバー（Ollama）: キーの欄を出さない', async () => {
    const html = await render({ preset: LLM_PROVIDER_PRESETS.ollama })
    expect(html).not.toContain('data-testid="ai-key"')
    expect(html).toContain('data-testid="ai-check"')
  })
})
