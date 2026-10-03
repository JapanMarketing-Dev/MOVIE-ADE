import { useEffect, useRef, useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import {
  DECISION_PRESETS,
  DECISION_PRESET_IDS,
  DEFAULT_DECISION_PREFERENCES,
  applyDecisionPreset,
  decisionSetupGuide,
  type DecisionPreferences,
  type DecisionPreset
} from '@shared/decision'
import type { SttAvailability } from '@shared/types'
import { Field } from '../ui'
import { useT } from '../lib/i18n'
import { AskAgent, CheckButton, GuideLinks, KeyField } from '../components/AiProviderFields'
import { RECOMMENDED_DECISION_PRESET, decisionReady } from './onboardingFlowState'

/**
 * セットアップの「判定モデル」の手順。おすすめの Ollama（端末内・キー不要。モデルは PC のメモリと GPU から clef / clef-flash を選ぶ）を
 * 選んだ状態で出す。Ollama が入っていなければ「Agent に設定を頼む」で Agent が入れてモデルまで落とす。
 * Cloudflare などを選んだときは Account ID と API トークン（自分のキー。OS の鍵で保存する KeyField）を入れてもらう。
 * 保存は設定の Decision model の節と同じ settings:decision。入力欄・プリセットの扱いも同じ（@shared/decision）。
 * 接続先とキーが揃ったときだけ有効にする（揃わないまま有効にすると、Agent への指示に判定が入るのに呼べない）。
 * 詳しい設定（ヘッダー・しきい値・料金など）は設定の画面に任せ、ここには出さない。
 */
/**
 * プリセットが入れる apiKeyEnv（CLOUDFLARE_API_TOKEN など）を外す。キーは「apiKey > apiKeyEnv > 保存したキー」の順で使われるので、
 * ここで保存したトークンを確実に使わせる（環境変数で渡したい人は設定の節で入れ直せる）。画像の渡し方などほかの値はプリセットのまま
 */
function withSavedKey(prefs: DecisionPreferences): DecisionPreferences {
  const { apiKeyEnv: _env, ...rest } = prefs
  return rest
}

export function DecisionStep() {
  const t = useT()
  const [prefs, setPrefs] = useState<DecisionPreferences | null>(null)
  const [available, setAvailable] = useState<SttAvailability | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)


  useEffect(() => {
    // 推奨のモデル（availability の localModels）を使うので、設定と一緒に読む
    void Promise.all([window.ade.invoke('app:settings'), window.ade.invoke('capture:availability').catch(() => null)]).then(([s, a]) => {
      if (a) setAvailable(a)
      const saved = s.decision ?? DEFAULT_DECISION_PREFERENCES
      // まだ使っていなければ、おすすめ（Ollama）を選んだ状態で出す。有効にしてある人の設定は変えない
      setPrefs(saved.enabled ? saved : withSavedKey(applyDecisionPreset(saved, RECOMMENDED_DECISION_PRESET, a?.localModels?.decision)))
    }).catch(() => setPrefs(withSavedKey(applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, RECOMMENDED_DECISION_PRESET))))
    return () => window.clearTimeout(saveTimer.current)
  }, [])

  if (!prefs) return null
  const def = DECISION_PRESETS[prefs.preset]
  const keyPresent = !!(def.vendor && available?.keys[def.vendor])

  /** 入力のたびに保存すると多いので少し待つ。揃っていれば有効にする */
  const save = (next: DecisionPreferences, hasKey = keyPresent, delay = 400) => {
    const withEnabled = { ...next, enabled: decisionReady(next, hasKey) }
    setPrefs(withEnabled)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.ade.invoke('settings:decision', withEnabled).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    }, delay)
  }
  const localModel = available?.localModels?.decision
  const choose = (preset: DecisionPreset) => save(withSavedKey(applyDecisionPreset(prefs, preset, localModel)), !!(DECISION_PRESETS[preset].vendor && available?.keys[DECISION_PRESETS[preset].vendor!]), 0)
  const label = (id: DecisionPreset) => (id === 'custom' ? t('decision.backend.custom') : DECISION_PRESETS[id].label)
  const endpoint = prefs.endpoint ?? def.endpoint
  const ready = decisionReady(prefs, keyPresent)

  return <div className="ob-stack" data-testid="onboarding-decision">
    <div className="ob-card">
      <div className="ob-card__head">
        <BadgeCheck size={14} aria-hidden="true" />
        <span className="ob-card__title">{label(prefs.preset)}</span>
        {prefs.preset === RECOMMENDED_DECISION_PRESET && <span className="ob-badge" data-testid="onboarding-decision-recommended">{t('onboarding.decision.recommended')}</span>}
      </div>
      <label className="ob-url ob-url--wide">
        <span className="ob-url__label">{t('onboarding.decision.provider')}</span>
        <span className="rv-select">
          <select className="st-select" value={prefs.preset} onChange={(e) => choose(e.target.value as DecisionPreset)}
            aria-label={t('onboarding.decision.provider')} data-testid="onboarding-decision-preset">
            {DECISION_PRESET_IDS.map((id) => <option key={id} value={id}>
              {id === RECOMMENDED_DECISION_PRESET ? t('onboarding.decision.recommendedOption', { label: label(id) }) : label(id)}</option>)}
          </select>
        </span>
      </label>
      {/* 提供元の案内（キーを作る・Account ID はここ・ドキュメント）と「Agent に設定を頼む」。設定の Decision の節と同じ部品 */}
      <div className="ob-row ob-row--start">
        <GuideLinks guide={decisionSetupGuide(prefs, label(prefs.preset), localModel)} kinds={['install', 'key', 'id', 'docs']} />
        <AskAgent guide={decisionSetupGuide(prefs, label(prefs.preset), localModel)} disabled={false}
          target={{ purpose: t('decision.setup.purpose'), endpointPath: 'decision', select: { path: 'decision.preset', value: prefs.preset }, enablePath: 'decision.enabled' }} />
      </div>
      {endpoint.includes('{account_id}') && <label className="ob-url ob-url--wide">
        <span className="ob-url__label">{t('decision.settings.accountId')}</span>
        <Field mono placeholder="0123456789abcdef…" autoComplete="off" spellCheck={false} aria-label={t('decision.settings.accountId')}
          value={prefs.accountId ?? ''} onChange={(e) => save({ ...prefs, accountId: e.target.value.trim() || undefined })} data-testid="onboarding-decision-account" />
      </label>}
      {prefs.preset === 'ollama' && <p className="ob-note">{t('onboarding.decision.ollamaHint', { model: prefs.model || def.model })}</p>}
      {prefs.preset === 'custom' && <p className="ob-note">{t('onboarding.decision.customHint')}</p>}
      {/* キーは OS の鍵で保存する（設定の節と同じ部品）。値は画面にも settings.json にも出さない */}
      {available && def.vendor && <KeyField key={`key-${def.vendor}`} vendor={def.vendor} label={label(prefs.preset)} envVar={prefs.apiKeyEnv} optional={false}
        placeholder="" available={available} disabled={false}
        // キーを保存・削除したら、揃ったかを見直して有効の状態を合わせる
        onChanged={() => void window.ade.invoke('capture:availability').then((next) => { setAvailable(next); save(prefs, !!next.keys[def.vendor!], 0) }).catch(() => undefined)} />}
      {/* 接続の確認（判定モデルに1回だけ短い依頼を送る。料金は利用者のキーにかかる）。揃うまでは押せない */}
      <CheckButton disabled={!ready} note={t('decision.test.note')}
        onCheck={() => window.ade.invoke('decision:testConnection', prefs)} />
      <p className={`ob-note${ready ? ' ob-note--ok' : ''}`} role="status" data-testid="onboarding-decision-status">
        {t(ready ? 'onboarding.decision.ready' : 'onboarding.decision.notReady')}</p>
    </div>
    <p className="ob-note">{t('onboarding.decision.byok')}</p>
    <p className="ob-note">{t('onboarding.decision.more')}</p>
  </div>
}
