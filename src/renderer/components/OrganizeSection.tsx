import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Sparkles } from 'lucide-react'
import { LLM_API_PROVIDERS, LLM_PROVIDER_PRESETS, providerLabel, type AiEndpointConfig, type LlmApiProvider } from '@shared/aiProviders'
import type { SttAvailability } from '@shared/types'
import { useT } from '../lib/i18n'
import { CheckButton, EndpointFields, KeyField } from './AiProviderFields'

/**
 * 設定の「指摘の整理」の節。CLI（Claude Code / Codex）は各自の契約をそのまま使い、
 * ここでは API キーで直接呼ぶ提供元（Anthropic / OpenAI / Gemini / OpenRouter / OpenAI 互換）の接続先とキーを設定する。
 * どれで整理するかは、指摘の画面の「整理」ボタンの横で選ぶ（ReviewFindings）。
 * 読み込み・保存は自分で IPC へ送る（閉じたときの一括保存の対象外）。
 */
export function OrganizeSection({ recording = false, headless = false }: { recording?: boolean; /** 見出しと外枠を出さない（設定ページの PageSection に入れるとき） */ headless?: boolean }) {
  const t = useT()
  const [provider, setProvider] = useState<LlmApiProvider>('anthropic')
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
    return () => window.clearTimeout(saveTimer.current)
  }, [reload])

  const saveEndpoints = (next: Partial<Record<LlmApiProvider, AiEndpointConfig>>) => {
    setEndpoints(next)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.ade.invoke('settings:organizer', { endpoints: next }).then(reload).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    }, 400)
  }

  const preset = LLM_PROVIDER_PRESETS[provider]
  const endpoint = endpoints[provider]

  const body = <>
      <p className="st-note">{t('ai.organize.cliNote')}</p>
      <label className="st-row"><span className="st-row__label">{t('ai.organize.provider')}</span><span className="rv-select">
        <select className="st-select" aria-label={t('ai.organize.provider')} value={provider} disabled={recording} onChange={(e) => setProvider(e.target.value as LlmApiProvider)} data-testid="organize-provider">
          {LLM_API_PROVIDERS.map((p) => <option key={p} value={p}>
            {providerLabel(LLM_PROVIDER_PRESETS[p], t)} — {t(available?.llm[p] ? 'ai.organize.ready' : 'ai.organize.notReady')}
          </option>)}
        </select></span></label>
      {available?.llm[provider]
        ? <p className="st-note st-note--ok"><CircleCheck size={12} aria-hidden="true" />{t('ai.organize.ready')}</p>
        : <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('ai.organize.notReady')}</p>}
      <p className="st-note">{t(preset.structuredOutput ? 'ai.organize.structured' : 'ai.organize.unstructured')}</p>
      <EndpointFields key={provider} preset={preset} value={endpoint} disabled={recording} testId="organize-endpoint"
        onChange={(next) => {
          const copy = { ...endpoints }
          if (next) copy[provider] = next
          else delete copy[provider]
          saveEndpoints(copy)
        }} />
      {available && <KeyField key={`key-${preset.vendor}`} vendor={preset.vendor} label={providerLabel(preset, t)} optional={!preset.keyRequired}
        placeholder={preset.keyPlaceholder} available={available} disabled={recording} onChanged={() => void reload()} />}
      <CheckButton disabled={recording} note={t('ai.organize.testNote')}
        onCheck={() => window.ade.invoke('organize:testConnection', { provider, ...(endpoint ? { endpoint } : {}) })} />
  </>
  // 設定ページの見出し付きの枠（PageSection）に入れるときは中身だけを出す
  if (headless) return body
  return <section className="st-section" id="settings-organize">
    <h3 className="st-section__title"><span className="st-section__icon st-section__icon--agent" aria-hidden="true"><Sparkles size={14} /></span>{t('ai.organize.title')}</h3>
    <div className="st-section__body">{body}</div>
  </section>
}
