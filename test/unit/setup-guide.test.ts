/**
 * 設定の案内（「キーを作る ↗」などのリンクと、Agent に設定を頼む指示文）のテスト。
 */
import { describe, expect, it } from 'vitest'
import { LLM_API_PROVIDERS, LLM_PROVIDER_PRESETS, STT_PROVIDER_PRESETS, STT_REMOTE_PROVIDERS, providerLabel } from '@shared/aiProviders'
import { DECISION_PRESETS } from '@shared/decision'
import { translate, type SupportedLocale } from '@shared/i18n'
import { buildAgentSetupPrompt, isSafeExternalUrl, setupLinks, type SetupGuide } from '@shared/setupGuide'

const PRESETS = [...STT_REMOTE_PROVIDERS.map((p) => ({ kind: 'stt' as const, preset: STT_PROVIDER_PRESETS[p] })),
  ...LLM_API_PROVIDERS.map((p) => ({ kind: 'llm' as const, preset: LLM_PROVIDER_PRESETS[p] }))]
const tOf = (locale: SupportedLocale) => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params)
const guideOf = (preset: (typeof PRESETS)[number]['preset']): SetupGuide => ({ ...preset, label: providerLabel(preset, tOf('en')) })
const TARGET = { purpose: 'transcription', settingsPath: '/Users/me/.ferret/settings.json', envPath: '/Users/me/.ferret/.env', endpointPath: 'capture.sttEndpoints.x', select: { path: 'capture.transcription', value: 'x' } }

describe('外部で開くリンク', () => {
  it('https だけを開いてよい（http・file・javascript・data・認証情報入り・壊れた値は断る）', () => {
    expect(isSafeExternalUrl('https://dash.cloudflare.com/profile/api-tokens')).toBe(true)
    for (const bad of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com', 'ftp://x', 'not a url', '', 42, null, undefined, `https://x.com/${'a'.repeat(2100)}`]) {
      expect(isSafeExternalUrl(bad), String(bad)).toBe(false)
    }
  })

  it('全プリセットの URL（キー・ID・ドキュメント・インストール）は https', () => {
    for (const { preset } of PRESETS) {
      for (const url of [preset.keyUrl, preset.idUrl, preset.docsUrl, preset.installUrl].filter((u) => u !== undefined)) {
        expect(isSafeExternalUrl(url), `${preset.id}: ${url}`).toBe(true)
      }
    }
  })

  it('キーの要る提供元には「キーを作る」、Cloudflare には「ID はここ」、端末内のサーバーには「インストール」が出る', () => {
    const kinds = (p: (typeof PRESETS)[number]['preset']) => setupLinks(guideOf(p)).map((l) => l.kind)
    expect(kinds(STT_PROVIDER_PRESETS.groq)).toEqual(['key', 'docs'])
    expect(kinds(LLM_PROVIDER_PRESETS.cloudflare)).toEqual(['key', 'id', 'docs'])
    expect(kinds(LLM_PROVIDER_PRESETS.ollama)).toEqual(['install', 'docs'])
    expect(kinds(STT_PROVIDER_PRESETS.compatible)).toEqual([])
    // https でない値が紛れても出さない
    expect(setupLinks({ ...guideOf(STT_PROVIDER_PRESETS.groq), keyUrl: 'javascript:alert(1)' }).map((l) => l.kind)).toEqual(['docs'])
  })
})

describe('環境変数の名前', () => {
  it('同じ提供元なら文字起こしと整理で同じ名前、キーの要る提供元（Custom 以外）には名前がある', () => {
    const byVendor = new Map<string, string>()
    for (const { preset } of PRESETS) {
      if (preset.keyRequired) expect(preset.envVar, preset.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
      if (!preset.envVar) continue
      const seen = byVendor.get(preset.vendor)
      if (seen) expect(preset.envVar, preset.id).toBe(seen)
      byVendor.set(preset.vendor, preset.envVar)
    }
  })

  it('各社の慣習の名前で、Cloudflare は判定モデルのプリセットと同じ（トークンと Account ID）', () => {
    expect(STT_PROVIDER_PRESETS.openai.envVar).toBe('OPENAI_API_KEY')
    expect(STT_PROVIDER_PRESETS.groq.envVar).toBe('GROQ_API_KEY')
    expect(LLM_PROVIDER_PRESETS.anthropic.envVar).toBe('ANTHROPIC_API_KEY')
    expect(LLM_PROVIDER_PRESETS.gemini.envVar).toBe('GEMINI_API_KEY')
    expect(LLM_PROVIDER_PRESETS['vercel-gateway'].envVar).toBe('AI_GATEWAY_API_KEY')
    expect(LLM_PROVIDER_PRESETS.cloudflare.envVar).toBe(DECISION_PRESETS.cloudflare.apiKeyEnv)
    expect(LLM_PROVIDER_PRESETS.cloudflare.idEnvVar).toBe('CLOUDFLARE_ACCOUNT_ID')
    expect(STT_PROVIDER_PRESETS.cloudflare.idEnvVar).toBe('CLOUDFLARE_ACCOUNT_ID')
  })
})

describe('Agent に設定を頼む指示文', () => {
  it('どの提供元・言語でも、キーの値は入らず、値を表示しないこと・settings.json にキーを書かないことを指示する', () => {
    for (const locale of ['en', 'ja'] as const) {
      for (const { preset } of PRESETS) {
        // 誤ってキーの入った物を渡しても、指示文には出ない（指示文の元にキーの欄は無い）
        const leaky = { ...guideOf(preset), apiKey: 'sk-secret-should-not-appear-123', accountId: 'acct-secret-999' } as SetupGuide
        const text = buildAgentSetupPrompt(leaky, TARGET, tOf(locale))
        expect(text, preset.id).not.toContain('sk-secret-should-not-appear-123')
        expect(text, preset.id).not.toContain('acct-secret-999')
        expect(text, preset.id).toContain(TARGET.settingsPath)
        expect(text).toContain(translate(locale, 'ai.setup.prompt.finish'))
        if (!preset.local) {
          expect(text, preset.id).toContain(TARGET.envPath)
          expect(text, preset.id).toContain('apiKeyEnv')
        }
      }
    }
  })

  it('Cloudflare: Account ID の調べ方（wrangler・公式のページ）、トークンを作るページと権限、.env の名前、選ぶ項目', () => {
    const text = buildAgentSetupPrompt(guideOf(LLM_PROVIDER_PRESETS.cloudflare),
      { ...TARGET, endpointPath: 'organizer.endpoints.cloudflare', select: { path: 'organizer.runner', value: 'api:cloudflare' } }, tOf('en'))
    expect(text).toContain('wrangler whoami')
    expect(text).toContain('https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/')
    expect(text).toContain('https://dash.cloudflare.com/profile/api-tokens')
    expect(text).toContain('Workers AI')
    expect(text).toContain('CLOUDFLARE_API_TOKEN=<key>')
    expect(text).toContain('"accountId" under "organizer.endpoints.cloudflare"')
    expect(text).toContain('"organizer.runner" to "api:cloudflare"')
    expect(text).toContain('do not sign in, create keys or grant permissions on my behalf')
    // 番号付きの手順
    expect(text).toMatch(/\n1\. .+\n2\. /)
  })

  it('Ollama（キーが要らない）: インストールのページと起動の確かめ方だけで、キーの手順は無い', () => {
    const text = buildAgentSetupPrompt(guideOf(LLM_PROVIDER_PRESETS.ollama), { ...TARGET, endpointPath: 'organizer.endpoints.ollama' }, tOf('ja'))
    expect(text).toContain('https://ollama.com/download')
    expect(text).toContain('curl http://localhost:11434/v1/models')
    expect(text).not.toContain('apiKeyEnv')
  })

  it('Custom: Base URL とモデル名を聞き、キーは要る場合だけ', () => {
    const text = buildAgentSetupPrompt(guideOf(STT_PROVIDER_PRESETS.compatible), TARGET, tOf('en'))
    expect(text).toContain('"baseUrl" and "model"')
    expect(text).toContain('If my server needs a key')
  })
})
