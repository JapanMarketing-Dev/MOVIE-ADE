import { useCallback, useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, Type } from 'lucide-react'
import {
  DECISION_PRESETS,
  DECISION_PRESET_IDS,
  DEFAULT_DECISION_PREFERENCES,
  DEFAULT_PASS_THRESHOLD,
  applyDecisionPreset,
  decisionModelSupportsImages,
  decisionTerminalEnvChanged,
  type DecisionAuthScheme,
  type DecisionImageFormat,
  type DecisionPreferences,
  type DecisionPreset
} from '@shared/decision'
import { formatHeaderLines, parseHeaderLines } from '@shared/aiProviders'
import type { SttAvailability } from '@shared/types'
import { Field, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { KeyField } from './AiProviderFields'
import '../styles/decision.css'

/** Agent が実行する依頼（設定の画面に見せる例。実際の手順は feedback.md の受け入れ確認の節） */
const CURL_PREVIEW = `curl -sS -X POST "$FERRET_DECISION_URL" \\
  -H 'content-type: application/json' --data-binary @req.json
# req.json = { "model": "$FERRET_DECISION_MODEL", "state": "<finding + Done when>",
#   "images": [BEFORE, AFTER] (base64, only if FERRET_DECISION_IMAGES=1),
#   "questions": { "done": noul, "status": choice } }`

/**
 * 設定の「判定モデル」の節。利用者が自分の System One 互換 API を入れる。
 * Ferret はここから API を呼ばない（接続の確認も無い）。有効にすると:
 *   - Agent のターミナルにローカル中継の URL・モデル・画像の可否を環境変数で渡す（キーは渡さない）
 *   - feedback.md と指示文に「全件が合格するまで判定を繰り返す」手順を足す
 * プリセットは欄を埋めるだけで、どの値も書き換えられる。保存は自分で IPC へ送る（OrganizeSection と同じ）。
 */
export function DecisionSection({ recording = false }: { recording?: boolean }) {
  const t = useT()
  const [prefs, setPrefs] = useState<DecisionPreferences>(DEFAULT_DECISION_PREFERENCES)
  const [available, setAvailable] = useState<SttAvailability | null>(null)
  // 追加のヘッダーは入力中の崩れた行も残したいので、文字列のまま持つ
  const [headerText, setHeaderText] = useState('')
  const saveTimer = useRef<number | undefined>(undefined)
  /** 開いているターミナルに渡した値（有効・モデル・画像）が変わったか。保存のあとに1度だけ知らせる */
  const envChanged = useRef(false)
  const toast = useToast()

  const reload = useCallback(() => window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined), []) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）

  useEffect(() => {
    void window.ade.invoke('app:settings').then((s) => {
      if (!s.decision) return
      setPrefs(s.decision)
      setHeaderText(formatHeaderLines(s.decision.headers))
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    void reload()
    return () => window.clearTimeout(saveTimer.current)
  }, [reload])

  const save = (next: DecisionPreferences, delay = 400) => {
    // 中継の URL はアプリを閉じるまで変わらない。モデルと画像の可否だけは開いたときの環境変数なので、変えたら開き直しを促す
    if (decisionTerminalEnvChanged(prefs, next)) envChanged.current = true
    setPrefs(next)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.ade.invoke('settings:decision', next).then(() => {
        if (!envChanged.current) return
        envChanged.current = false
        toast({ tone: 'info', message: t('decision.settings.reopenTerminals') })
      }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    }, delay)
  }
  const patch = (p: Partial<DecisionPreferences>, delay?: number) => save({ ...prefs, ...p }, delay)

  const def = DECISION_PRESETS[prefs.preset]
  const endpoint = prefs.endpoint ?? def.endpoint
  const model = prefs.model ?? def.model
  const images = prefs.images ?? def.images
  const imageFormat = prefs.imageFormat ?? def.imageFormat
  const authScheme = prefs.authScheme ?? def.authScheme
  const presetLabel = (id: DecisionPreset) => (id === 'custom' ? t('decision.backend.custom') : DECISION_PRESETS[id].label)
  const listId = 'decision-models'
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

  return <div id="settings-verify" className="st-page__group" data-testid="decision-settings">
    {/* 位置づけ（Agent が期待どおりに動いたかを定義する・BYOK）。Ferret 自身が呼ばない・中継の説明は下の intro が持つ */}
    <p className="st-note" data-testid="decision-concept">{t('decision.settings.concept')}</p>
    <p className="st-note">{t('decision.settings.intro')}</p>
    <label className="st-row st-row--switch" data-disabled={recording || undefined}>
      <span className="st-row__label">{t('decision.settings.enable')}</span>
      <input type="checkbox" role="switch" className="st-switch" checked={prefs.enabled} disabled={recording}
        onChange={(e) => patch({ enabled: e.target.checked }, 0)} data-testid="decision-enabled" />
    </label>

    <label className="st-row"><span className="st-row__label">{t('decision.settings.preset')}</span><span className="rv-select">
      <select className="st-select" aria-label={t('decision.settings.preset')} value={prefs.preset} disabled={recording} data-testid="decision-preset"
        onChange={(e) => {
          const next = applyDecisionPreset(prefs, e.target.value as DecisionPreset)
          setHeaderText('')
          save(next, 0)
        }}>
        {DECISION_PRESET_IDS.map((id) => <option key={id} value={id}>{presetLabel(id)}</option>)}
      </select></span></label>
    <p className="st-note">{t('decision.settings.presetNote')}</p>

    <label className="st-row"><span className="st-row__label">{t('decision.settings.endpoint')}</span>
      <Field mono aria-label={t('decision.settings.endpoint')} placeholder={def.endpoint || 'https://…/v1/systemone'} autoComplete="off" spellCheck={false}
        value={endpoint} disabled={recording} onChange={(e) => patch({ endpoint: e.target.value })} data-testid="decision-endpoint" /></label>
    <p className="st-note">{t('decision.settings.endpointHint')}</p>
    {endpoint.includes('{account_id}') && <>
      <label className="st-row"><span className="st-row__label">{t('decision.settings.accountId')}</span>
        <Field mono aria-label={t('decision.settings.accountId')} placeholder="CLOUDFLARE_ACCOUNT_ID" autoComplete="off" spellCheck={false}
          value={prefs.accountId ?? ''} disabled={recording} onChange={(e) => patch({ accountId: e.target.value || undefined })} /></label>
      <p className="st-note">{t('decision.settings.accountIdHint')}</p>
    </>}

    <label className="st-row"><span className="st-row__label">{t('ai.endpoint.model')}</span>
      <Field mono aria-label={t('ai.endpoint.model')} placeholder={def.model || 'clef-flash'} autoComplete="off" spellCheck={false} list={listId}
        value={model} disabled={recording} onChange={(e) => patch({ model: e.target.value })} data-testid="decision-model" /></label>
    <datalist id={listId}>{def.models.map((m) => <option key={m.id} value={m.id} />)}</datalist>
    {def.models.length > 0 && <div className="st-decision__models" role="list">
      {def.models.map((m) => <button key={m.id} type="button" role="listitem" className="st-decision__model" aria-pressed={model === m.id} disabled={recording}
        onClick={() => patch({ model: m.id, images: m.images }, 0)}>
        <code>{m.id}</code>
        <span className={`st-decision__cap${m.images ? ' is-images' : ''}`}>{m.images ? <ImageIcon size={11} aria-hidden="true" /> : <Type size={11} aria-hidden="true" />}
          {t(m.images ? 'decision.settings.imagesBadge' : 'decision.settings.textBadge')}</span>
      </button>)}
    </div>}
    <label className="st-row st-row--switch" data-disabled={recording || undefined}>
      <span className="st-row__label">{t('decision.settings.images')}</span>
      <input type="checkbox" role="switch" className="st-switch" checked={images} disabled={recording} onChange={(e) => patch({ images: e.target.checked }, 0)} data-testid="decision-images" />
    </label>
    {images && <label className="st-row"><span className="st-row__label">{t('decision.settings.imageFormat')}</span><span className="rv-select">
      <select className="st-select" aria-label={t('decision.settings.imageFormat')} value={imageFormat} disabled={recording} data-testid="decision-image-format"
        onChange={(e) => patch({ imageFormat: e.target.value as DecisionImageFormat }, 0)}>
        <option value="base64">{t('decision.settings.imageFormatBase64')}</option>
        <option value="data-uri">{t('decision.settings.imageFormatDataUri')}</option>
      </select></span></label>}
    <p className={`st-note${decisionModelSupportsImages(model) ? ' st-note--ok' : ' st-note--warn'}`}>
      {t(decisionModelSupportsImages(model) ? 'decision.settings.imagesOk' : 'decision.settings.imagesUnknown')}</p>

    {prefs.preset === 'ollama' && <>
      <pre className="st-decision__cmd"><code>ollama pull {model || 'clef-flash'}</code></pre>
      <p className="st-note">{t('decision.settings.ollamaHint')}</p>
    </>}

    <label className="st-row"><span className="st-row__label">{t('decision.settings.auth')}</span><span className="rv-select">
      <select className="st-select" aria-label={t('decision.settings.auth')} value={authScheme} disabled={recording} onChange={(e) => patch({ authScheme: e.target.value as DecisionAuthScheme }, 0)}>
        <option value="bearer">{t('decision.settings.authBearer')}</option>
        <option value="header">{t('decision.settings.authHeader')}</option>
        <option value="none">{t('decision.settings.authNone')}</option>
      </select></span></label>
    {authScheme === 'header' && <label className="st-row"><span className="st-row__label">{t('decision.settings.authHeaderName')}</span>
      <Field mono aria-label={t('decision.settings.authHeaderName')} placeholder="x-api-key" autoComplete="off" spellCheck={false}
        value={prefs.authHeader ?? ''} disabled={recording} onChange={(e) => patch({ authHeader: e.target.value || undefined })} /></label>}
    {authScheme !== 'none' && <>
      <label className="st-row"><span className="st-row__label">{t('decision.settings.apiKeyEnv')}</span>
        <Field mono aria-label={t('decision.settings.apiKeyEnv')} placeholder={def.apiKeyEnv ?? 'MY_API_KEY'} autoComplete="off" spellCheck={false}
          value={prefs.apiKeyEnv ?? ''} disabled={recording} onChange={(e) => patch({ apiKeyEnv: e.target.value || undefined })} /></label>
      <p className="st-note">{t('decision.settings.apiKeyEnvHint')}</p>
      {available && def.vendor && <KeyField key={`key-${def.vendor}`} vendor={def.vendor} label={presetLabel(prefs.preset)} optional
        placeholder="" available={available} disabled={recording} onChanged={() => void reload()} />}
    </>}

    <details className="st-key">
      <summary><span>{t('decision.settings.headers')} · {t('decision.settings.threshold')} · {t('decision.settings.pricing')}</span></summary>
      <div className="st-key__body">
        <label className="st-prompt"><span className="st-row__label">{t('decision.settings.headers')}</span>
          <textarea className="st-textarea" rows={2} aria-label={t('decision.settings.headers')} placeholder="cf-aig-authorization: ${CF_AIG_TOKEN}" spellCheck={false} disabled={recording}
            value={headerText} onChange={(e) => { setHeaderText(e.target.value); patch({ headers: parseHeaderLines(e.target.value) }) }} /></label>
        <p className="st-note">{t('decision.settings.headersHint')}</p>
        <label className="st-row"><span className="st-row__label">{t('decision.settings.threshold')}</span>
          <Field mono type="number" min={0.5} max={0.99} step={0.05} aria-label={t('decision.settings.threshold')} placeholder={String(DEFAULT_PASS_THRESHOLD)} disabled={recording}
            value={prefs.passThreshold !== undefined ? String(prefs.passThreshold) : ''} onChange={(e) => patch({ passThreshold: num(e.target.value) })} data-testid="decision-threshold" /></label>
        <p className="st-note">{t('decision.settings.thresholdHint')}</p>
        <div className="st-decision__pricing">
          <label className="st-row"><span className="st-row__label">{t('decision.settings.pricingIn')}</span>
            <Field mono type="number" min={0} step={0.01} aria-label={t('decision.settings.pricingIn')} placeholder="—" disabled={recording}
              value={prefs.pricing?.inputPer1M !== undefined ? String(prefs.pricing.inputPer1M) : ''} onChange={(e) => patch({ pricing: { ...prefs.pricing, inputPer1M: num(e.target.value) } })} /></label>
          <label className="st-row"><span className="st-row__label">{t('decision.settings.pricingOut')}</span>
            <Field mono type="number" min={0} step={0.01} aria-label={t('decision.settings.pricingOut')} placeholder="—" disabled={recording}
              value={prefs.pricing?.outputPer1M !== undefined ? String(prefs.pricing.outputPer1M) : ''} onChange={(e) => patch({ pricing: { ...prefs.pricing, outputPer1M: num(e.target.value) } })} /></label>
        </div>
        <p className="st-note">{t('decision.settings.pricingHint')}</p>
      </div>
    </details>

    <h3 className="st-page__subheading">{t('decision.settings.curlTitle')}</h3>
    <pre className="st-decision__cmd" data-testid="decision-curl"><code>{CURL_PREVIEW}</code></pre>
    <p className="st-note">{t('decision.settings.curlNote')}</p>
  </div>
}
