import { useEffect, useRef, useState } from 'react'
import { AudioLines, CircleAlert, CircleCheck } from 'lucide-react'
import { STT_PROVIDER_PRESETS, STT_REMOTE_PROVIDERS, providerLabel, transcriptionLayout, type AiEndpointConfig, type SttRemoteProvider } from '@shared/aiProviders'
import type { SttAvailability, SttProvider } from '@shared/types'
import { useT } from '../lib/i18n'
import { ProviderSetup } from './AiProviderFields'
import { WhisperModelSection } from './WhisperModelSection'
import type { SttLanguageCode } from '@shared/sttLanguages'
import { SttLanguageSelect } from '../ui'

export type SpeechLanguageValue = SttLanguageCode

/** 費用上限の選択肢（USD）。設定ファイルで別の値にしていても選択肢に足して見せる */
const COST_LIMITS = [0.1, 0.5, 1, 5, 20]

/**
 * 設定の「文字起こし」の節。① Engine（端末内の whisper か提供元）→ ② モデル（推奨を選んだ状態）→ ③ API キー の3段。
 * 端末内は ③ が「推奨モデルをダウンロード」になる。ほかの項目（Base URL・タイムアウト・ヘッダー・費用の上限）は「詳細」へ。
 * オンボーディング（onboarding）では言語（自動のまま）と「詳細」を出さない。
 * 接続先の上書き・費用の上限・キーは、ここでその場で保存する（閉じたときの一括保存の対象外）。
 * どれを使うか（transcription）と言語はフッターと共有するので、App の state を受け取る。
 */
export function TranscriptionSection({ transcription, onTranscriptionChange, language, onLanguageChange, recording, available, onAvailabilityChange, onPickModel, onModelChanged, headless = false, onboarding = false }: {
  transcription: SttProvider
  onTranscriptionChange: (next: SttProvider) => void
  language: SpeechLanguageValue
  onLanguageChange: (next: SpeechLanguageValue) => void
  recording: boolean
  available: SttAvailability
  /** キー・接続先を変えたあと、使える状態を読み直す */
  onAvailabilityChange: () => void
  onPickModel: () => void
  onModelChanged: () => void
  /** 見出しと外枠を出さない（設定ページの PageSection に入れるとき） */
  headless?: boolean
  /** オンボーディングの手順。言語と「詳細」を出さない */
  onboarding?: boolean
}) {
  const t = useT()
  const [endpoints, setEndpoints] = useState<Partial<Record<SttRemoteProvider, AiEndpointConfig>>>({})
  const [costLimitUsd, setCostLimitUsd] = useState<number | null>(1)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void window.ade.invoke('app:settings').then((s) => {
      setEndpoints(s.capture?.sttEndpoints ?? {})
      setCostLimitUsd(s.capture?.costLimitUsd === undefined ? 1 : s.capture.costLimitUsd)
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    return () => window.clearTimeout(saveTimer.current)
  }, [])

  /** 入力のたびに保存すると多いので少し待つ。保存後に使える状態を読み直す */
  const saveEndpoints = (next: Partial<Record<SttRemoteProvider, AiEndpointConfig>>) => {
    setEndpoints(next)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.ade.invoke('settings:stt', { sttEndpoints: next }).then(onAvailabilityChange).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    }, 400)
  }
  const saveCostLimit = (next: number | null) => {
    setCostLimitUsd(next)
    void window.ade.invoke('settings:stt', { costLimitUsd: next })
  }

  const remote = transcription === 'local' ? null : STT_PROVIDER_PRESETS[transcription]
  const endpoint = remote ? endpoints[remote.id] : undefined
  const layout = transcriptionLayout(transcription, { onboarding })

  const body = <>
      {/* 文字起こしの言語は whisper の対応言語すべて（src/shared/sttLanguages.ts）。検索して選ぶ */}
      {layout.language && <div className="st-row"><span className="st-row__label">{t('settings.capture.language')}</span>
        <SttLanguageSelect ariaLabel={t('settings.capture.languageLabel')} value={language} disabled={recording} onChange={onLanguageChange}
          testId="settings-stt-language" provider={remote ? { id: transcription, label: providerLabel(remote, t) } : undefined} /></div>}
      {/* ① Engine。選ぶ場所はここ1つ（オンボーディングのカードは使わない）。Custom は自前の GPU などの OpenAI 互換 */}
      <label className="st-row"><span className="st-row__label">{t('settings.capture.engine')}</span><span className="rv-select">
        <select className="st-select" aria-label={t('settings.capture.engineLabel')} value={transcription} disabled={recording} onChange={(e) => onTranscriptionChange(e.target.value as SttProvider)} data-testid="stt-provider">
          <option value="local">{t('settings.capture.engineLocal')}</option>
          {STT_REMOTE_PROVIDERS.map((p) => <option key={p} value={p}>{p === 'compatible' ? t('ai.providerCustom') : providerLabel(STT_PROVIDER_PRESETS[p], t)}</option>)}
        </select></span></label>

      {!remote && <>
        {available.localReady
          ? <p className="st-note st-note--ok"><CircleCheck size={12} aria-hidden="true" />{t('settings.capture.localReady')}</p>
          : <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('settings.capture.localMissing')}</p>}
        {/* ③ の代わりに、推奨モデルのワンクリックのダウンロード */}
        <WhisperModelSection disabled={recording} onPickModel={onPickModel} onChanged={onModelChanged} />
      </>}

      {remote && <>
        <p className="st-note">{t('ai.stt.sentTo', { label: providerLabel(remote, t) })}</p>
        {/* 提供元を切り替えたら作り直す（入力中の下書きを持ち越さない。保存した値は提供元ごとに残る） */}
        <ProviderSetup key={remote.id} preset={remote} value={endpoint} disabled={recording} onboarding={onboarding} testId="stt-endpoint"
          available={available} onAvailabilityChange={onAvailabilityChange}
          onChange={(next) => {
            const copy = { ...endpoints }
            if (next) copy[remote.id] = next
            else delete copy[remote.id]
            saveEndpoints(copy)
          }}
          onCheck={() => window.ade.invoke('capture:testConnection', { provider: remote.id, ...(endpoint ? { endpoint } : {}) })}
          advancedExtra={<>
            <label className="st-row"><span className="st-row__label">{t('settings.capture.costLimit')}</span><span className="rv-select">
              <select className="st-select" aria-label={t('settings.capture.costLimitLabel')} value={costLimitUsd === null ? 'none' : String(costLimitUsd)} disabled={recording}
                onChange={(e) => saveCostLimit(e.target.value === 'none' ? null : Number(e.target.value))}>
                <option value="none">{t('settings.capture.costLimitNone')}</option>
                {[...new Set([...COST_LIMITS, ...(costLimitUsd === null ? [] : [costLimitUsd])])].sort((a, b) => a - b)
                  .map((usd) => <option key={usd} value={String(usd)}>{t('settings.capture.costLimitOption', { usd })}</option>)}
              </select></span></label>
            <p className="st-note">{remote.pricePerMinuteUsd !== null
              ? t('ai.stt.price', { perHour: (remote.pricePerMinuteUsd * 60).toFixed(2) })
              : t('ai.stt.priceUnknown')}</p>
          </>} />
      </>}
  </>
  // 設定ページの見出し付きの枠（PageSection）に入れるときは中身だけを出す
  if (headless) return body
  return <section className="st-section" id="settings-transcription">
    <h3 className="st-section__title"><span className="st-section__icon st-section__icon--agent" aria-hidden="true"><AudioLines size={14} /></span>{t('settings.capture.title')}</h3>
    <div className="st-section__body">{body}</div>
  </section>
}
