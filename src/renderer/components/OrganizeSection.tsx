import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { LLM_API_PROVIDERS, LLM_PROVIDER_PRESETS, RECOMMENDED_ORGANIZE_PROVIDER, organizeCheckTarget, providerLabel, type AiEndpointConfig, type LlmApiProvider } from '@shared/aiProviders'
import { withRecommendedModel } from '@shared/localModels'
import type { SttAvailability } from '@shared/types'
import { useT } from '../lib/i18n'
import { notifyOrganizerChanged, onOrganizerChanged } from '../lib/organizerEvents'
import { ProviderSetup } from './AiProviderFields'

/**
 * 設定の「指摘の整理」の節。CLI（Claude Code / Codex）は各自の契約をそのまま使い、
 * ここでは API キーで直接呼ぶ提供元（Anthropic / OpenAI / Gemini / OpenRouter / OpenAI 互換）の接続先とキーを設定する。
 * どれで整理するかは、指摘の画面の「整理」ボタンの横で選ぶ（ReviewFindings）。
 * 読み込み・保存は自分で IPC へ送る（閉じたときの一括保存の対象外）。
 */
export function OrganizeSection({ recording = false, headless = false }: { recording?: boolean; /** 見出しと外枠を出さない（設定ページの PageSection に入れるとき） */ headless?: boolean }) {
  const t = useT()
  // 既定はおすすめの Ollama（端末内・キー不要。モデルは PC に合わせて main が選ぶ）
  const [provider, setProvider] = useState<LlmApiProvider>(RECOMMENDED_ORGANIZE_PROVIDER)
  const [endpoints, setEndpoints] = useState<Partial<Record<LlmApiProvider, AiEndpointConfig>>>({})
  const [available, setAvailable] = useState<SttAvailability | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  const reload = useCallback(() => window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined), []) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）

  useEffect(() => {
    void window.ade.invoke('app:settings').then((s) => {
      setEndpoints(s.organizer?.endpoints ?? {})
      // 前回 API で整理していたら、その提供元を開いておく
      const runner = s.organizer?.runner
      if (runner?.startsWith('api:')) setProvider(runner.slice(4) as LlmApiProvider)
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    void reload()
    // 指摘の画面の「整理」の横でモデルを選び直したとき・settings.json を書き換えたときに映す（ここで打っている途中の値は上書きしない）
    const apply = (s: { organizer?: { endpoints?: Partial<Record<LlmApiProvider, AiEndpointConfig>> } }) => {
      if (saveTimer.current === undefined) setEndpoints(s.organizer?.endpoints ?? {})
    }
    const offFile = window.ade.on('settings:changed', apply)
    const offApp = onOrganizerChanged(() => void window.ade.invoke('app:settings').then(apply).catch(() => undefined)) // 失敗は main の IPC が Sentry へ送る
    return () => { offFile(); offApp(); window.clearTimeout(saveTimer.current) }
  }, [reload])

  const saveEndpoints = (next: Partial<Record<LlmApiProvider, AiEndpointConfig>>) => {
    setEndpoints(next)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined
      void window.ade.invoke('settings:organizer', { endpoints: next }).then(() => { notifyOrganizerChanged(); return reload() }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    }, 400)
  }

  // Ollama の推奨のモデルは、この PC のメモリと GPU から main が選んだもの（@shared/localModels）
  const localModel = provider === 'ollama' ? available?.localModels?.organize : undefined
  const preset = localModel ? { ...LLM_PROVIDER_PRESETS[provider], model: localModel, models: withRecommendedModel(LLM_PROVIDER_PRESETS[provider].models, localModel) } : LLM_PROVIDER_PRESETS[provider]
  const endpoint = endpoints[provider]

  // 提供元 → モデル → キーの3段（文字起こしと同じ部品）。どれで整理するかは指摘の画面の「整理」の横で選ぶ
  const body = <>
      <p className="st-note">{t('ai.organize.cliNote')}</p>
      <label className="st-row"><span className="st-row__label">{t('ai.organize.provider2')}</span><span className="rv-select">
        <select className="st-select" aria-label={t('ai.organize.provider')} value={provider} disabled={recording} onChange={(e) => setProvider(e.target.value as LlmApiProvider)} data-testid="organize-provider">
          {LLM_API_PROVIDERS.map((p) => <option key={p} value={p}>
            {p === 'compatible' ? t('ai.providerCustom') : p === RECOMMENDED_ORGANIZE_PROVIDER ? t('onboarding.decision.recommendedOption', { label: providerLabel(LLM_PROVIDER_PRESETS[p], t) }) : providerLabel(LLM_PROVIDER_PRESETS[p], t)}{available?.llm[p] ? ' ✓' : ''}
          </option>)}
        </select></span></label>
      {available && <ProviderSetup key={provider} preset={preset} value={endpoint} disabled={recording} testId="organize-endpoint"
        available={available} onAvailabilityChange={() => void reload()}
        onChange={(next) => {
          const copy = { ...endpoints }
          if (next) copy[provider] = next
          else delete copy[provider]
          saveEndpoints(copy)
        }}
        // 画面に出ているモデル（Ollama はこの PC の推奨を含む）で確かめる。main の既定（プリセットの model）に任せない
        onCheck={() => window.ade.invoke('organize:testConnection', organizeCheckTarget(provider, preset, endpoint))}
        // Agent に設定を頼む指示文の宛先（settings.json の中の場所。src/shared/settingsSchema.ts）
        setupTarget={{ purpose: t('ai.setup.purpose.organize'), endpointPath: `organizer.endpoints.${provider}`, select: { path: 'organizer.runner', value: `api:${provider}` } }}
        advancedExtra={<p className="st-note">{t(preset.structuredOutput ? 'ai.organize.structured' : 'ai.organize.unstructured')}</p>} />}
  </>
  // 設定ページの見出し付きの枠（PageSection）に入れるときは中身だけを出す
  if (headless) return body
  return <section className="st-section" id="settings-organize">
    <h3 className="st-section__title"><span className="st-section__icon st-section__icon--agent" aria-hidden="true"><Sparkles size={14} /></span>{t('ai.organize.title')}</h3>
    <div className="st-section__body">{body}</div>
  </section>
}
