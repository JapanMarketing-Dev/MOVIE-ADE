/**
 * 「Agent に設定を頼む」の指示文と「確認」が、プリセットの既定ではなく画面で今選ばれているモデルを使うこと。
 * 報告: 指摘の整理で Ollama の gpt-oss:120b を選んだのに、送った指示文には gpt-oss:20b が入っていた。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LLM_PROVIDER_PRESETS, STT_PROVIDER_PRESETS, currentModel, endpointSetupGuide, organizeCheckTarget, selectModel, type AiEndpointConfig } from '@shared/aiProviders'
import { withRecommendedModel } from '@shared/localModels'
import { SUPPORTED_LOCALES, setLocale, translate } from '@shared/i18n'
import { buildAgentSetupPrompt } from '@shared/setupGuide'
import { decisionSetupGuide } from '@shared/decision'
import { ApiLlmRunner, checkLlmRunner, describeLlmFailure } from '../../src/main/pipeline/organize/runners/api'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))

beforeEach(() => setLocale('ja'))
afterEach(() => { vi.unstubAllGlobals() })

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('ja', key, params)
const TARGET = { purpose: '指摘の整理', settingsPath: '/home/taro/.ferret/settings.json', envPath: '/home/taro/.ferret/.env', endpointPath: 'organizer.endpoints.ollama', select: { path: 'organizer.runner', value: 'api:ollama' } }
const ollama = LLM_PROVIDER_PRESETS.ollama
/** 設定の画面（OrganizeSection）と同じ形: この PC の推奨を混ぜた Ollama のプリセット */
const ollamaFor = (localModel: string) => ({ ...ollama, model: localModel, models: withRecommendedModel(ollama.models, localModel) })
const promptFor = (preset: typeof ollama, value: AiEndpointConfig | undefined) => buildAgentSetupPrompt(endpointSetupGuide(preset, value, 'Ollama'), TARGET, t)

describe('Agent に設定を頼む: 今のモデルの選択で指示文を作る', () => {
  it('Ollama で gpt-oss:120b を選ぶと、指示文の pull と settings.json に書くモデルは 120b（既定の 20b ではない）', () => {
    const value = selectModel(ollama, undefined, 'gpt-oss:120b')
    const prompt = promptFor(ollama, value)
    expect(prompt).toContain('ollama pull gpt-oss:120b')
    expect(prompt).toContain('"model": "gpt-oss:120b"')
    expect(prompt).not.toContain('gpt-oss:20b')
  })

  it('選び直した直後（保存を待たずに）作っても、新しい値になる', () => {
    const preset = ollamaFor('gpt-oss:20b')
    let value = selectModel(preset, undefined, 'gpt-oss:20b')
    expect(promptFor(preset, value)).toContain('ollama pull gpt-oss:20b')
    value = selectModel(preset, value, 'gpt-oss:120b')
    expect(promptFor(preset, value)).toContain('ollama pull gpt-oss:120b')
    value = selectModel(preset, value, 'qwen3:8b')
    const prompt = promptFor(preset, value)
    expect(prompt).toContain('ollama pull qwen3:8b')
    expect(prompt).not.toMatch(/gpt-oss/)
  })

  it('まだ選んでいなければ、画面に出ている推奨（この PC に合わせたもの）を使う', () => {
    const preset = ollamaFor('gpt-oss:120b')
    expect(currentModel(preset, undefined)).toBe('gpt-oss:120b')
    expect(promptFor(preset, undefined)).toContain('ollama pull gpt-oss:120b')
  })

  it('詳細で変えた Base URL も指示文に入る', () => {
    const prompt = promptFor(ollama, { model: 'gpt-oss:120b', baseUrl: 'http://127.0.0.1:11500/v1' })
    expect(prompt).toContain('curl http://127.0.0.1:11500/v1/models')
  })

  it('クラウドの提供元も、選んだモデルを案内に使う（キーや Base URL の上書き以外は消さない）', () => {
    for (const preset of [LLM_PROVIDER_PRESETS.openai, LLM_PROVIDER_PRESETS.cloudflare, STT_PROVIDER_PRESETS.groq]) {
      const other = preset.models.find((m) => !m.recommended)
      if (!other) continue
      const guide = endpointSetupGuide(preset, selectModel(preset, undefined, other.id), preset.label)
      expect(guide.model, preset.id).toBe(other.id)
      expect(guide.keyRequired).toBe(preset.keyRequired)
    }
  })

  it('判定モデルの指示文も、画面の今のモデル（prefs.model）を pull させ settings.json に書かせる', () => {
    const guide = decisionSetupGuide({ preset: 'ollama', model: 'clef' }, 'Ollama', 'clef-flash')
    const prompt = buildAgentSetupPrompt(guide, { ...TARGET, endpointPath: 'decision' }, t)
    expect(prompt).toContain('ollama pull clef')
    expect(prompt).toContain('"decision" に "model": "clef"')
  })

  it('新しい手順の文言は全言語にあり、モデル名と場所が入る', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const s = translate(locale, 'ai.setup.prompt.model', { model: 'gpt-oss:120b', path: 'organizer.endpoints.ollama', settingsPath: '/s.json' })
      expect(s, locale).toContain('"model": "gpt-oss:120b"')
      expect(s, locale).toContain('organizer.endpoints.ollama')
      expect(s, locale).toContain('/s.json')
    }
  })
})

describe('確認: 今の選択で確かめ、モデルが無ければ pull を案内する', () => {
  it('まだ選んでいない Ollama でも、画面に出ている推奨のモデルを送る', () => {
    expect(organizeCheckTarget('ollama', ollamaFor('gpt-oss:120b'), undefined)).toEqual({ provider: 'ollama', endpoint: { model: 'gpt-oss:120b' } })
    const value = selectModel(ollama, undefined, 'qwen3:8b')
    expect(organizeCheckTarget('ollama', ollama, value).endpoint?.model).toBe('qwen3:8b')
    // モデルの無い提供元（LM Studio・OpenAI 互換）で未入力なら何も足さない
    expect(organizeCheckTarget('lmstudio', LLM_PROVIDER_PRESETS.lmstudio, undefined)).toEqual({ provider: 'lmstudio' })
  })

  it('Ollama がモデルを知らない 404 は、ollama pull <model> で入れる手順を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"model \\"gpt-oss:120b\\" not found, try pulling it first"}', { status: 404 })))
    const r = await checkLlmRunner({ provider: 'ollama', endpoint: { model: 'gpt-oss:120b' } })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('ollama pull gpt-oss:120b')
    expect(r.message).not.toContain('404')
  })

  it('Ollama 以外の 404 はこれまでどおりモデル名の確認を促す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"model: x not found"}}', { status: 404 })))
    const err = await new ApiLlmRunner({ provider: 'openai', apiKey: 'k' }).run({ prompt: 'p', schema: {}, cwd: '/', timeoutMs: 1000 }).catch((e: Error) => e) as Error
    expect(err.message).toContain('モデル名を確認')
    expect(err.message).not.toContain('ollama pull')
  })

  it('pull を案内する文言は全言語にあり、コマンドがそのまま入る', () => {
    for (const locale of SUPPORTED_LOCALES) {
      setLocale(locale)
      expect(describeLlmFailure(404, 'model "m:1b" not found, try pulling it first', 'Ollama', 'm:1b'), locale).toContain('`ollama pull m:1b`')
    }
  })
})
