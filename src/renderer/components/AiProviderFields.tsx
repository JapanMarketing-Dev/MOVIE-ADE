import { useState } from 'react'
import { CircleAlert, CircleCheck, KeyRound } from 'lucide-react'
import type { AiEndpointConfig, AiVendor } from '@shared/aiProviders'
import type { SttAvailability } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { Button, Field } from '../ui'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'

/**
 * 設定の文字起こし・整理の節で共有する部品（接続先・キー・接続の確認）。
 * 利用者は AI を使う開発者なので、Base URL・モデル・タイムアウト・追加のヘッダーまで出す。
 */

/** 「名前: 値」の行をヘッダーの表にする。形の崩れた行は捨てる（main 側でもう一度確かめる） */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9-]{1,64})\s*:\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

export function formatHeaderLines(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')
}

/** 上書きの空の項目を落とす（空ならプリセットを使う） */
export function compactEndpoint(cfg: AiEndpointConfig): AiEndpointConfig | undefined {
  const out: AiEndpointConfig = {}
  if (cfg.baseUrl?.trim()) out.baseUrl = cfg.baseUrl.trim()
  if (cfg.model?.trim()) out.model = cfg.model.trim()
  if (cfg.timeoutMs) out.timeoutMs = cfg.timeoutMs
  if (cfg.headers && Object.keys(cfg.headers).length) out.headers = cfg.headers
  if (cfg.apiVersion?.trim()) out.apiVersion = cfg.apiVersion.trim()
  return Object.keys(out).length ? out : undefined
}

/** Base URL・モデル・（Azure なら API バージョン）・タイムアウト・追加のヘッダー */
export function EndpointFields({ preset, value, onChange, disabled, azure, testId }: {
  preset: { baseUrl: string; model: string; modelExamples?: readonly string[] }
  value: AiEndpointConfig | undefined
  onChange: (next: AiEndpointConfig | undefined) => void
  disabled: boolean
  /** Azure OpenAI はモデル名の代わりにデプロイ名、api-version を出す */
  azure?: boolean
  testId?: string
}) {
  const t = useT()
  const v = value ?? {}
  // ヘッダーは入力中の崩れた行も残したいので、文字列のまま持つ
  const [headerText, setHeaderText] = useState(() => formatHeaderLines(v.headers))
  const patch = (p: Partial<AiEndpointConfig>) => onChange(compactEndpoint({ ...v, ...p }))
  return <div className="st-endpoint" data-testid={testId}>
    <label className="st-row"><span className="st-row__label">{t('ai.endpoint.baseUrl')}</span>
      <Field mono aria-label={t('ai.endpoint.baseUrl')} placeholder={preset.baseUrl || 'https://…'} autoComplete="off" spellCheck={false}
        value={v.baseUrl ?? ''} disabled={disabled} onChange={(e) => patch({ baseUrl: e.target.value })} /></label>
    <label className="st-row"><span className="st-row__label">{t(azure ? 'ai.endpoint.deployment' : 'ai.endpoint.model')}</span>
      <Field mono aria-label={t(azure ? 'ai.endpoint.deployment' : 'ai.endpoint.model')} placeholder={preset.model} autoComplete="off" spellCheck={false}
        value={v.model ?? ''} disabled={disabled} onChange={(e) => patch({ model: e.target.value })}
        {...(preset.modelExamples?.length ? { list: `${testId ?? 'endpoint'}-models` } : {})} /></label>
    {/* モデル名の候補（自由に入力もできる） */}
    {preset.modelExamples?.length ? <datalist id={`${testId ?? 'endpoint'}-models`}>
      {preset.modelExamples.map((m) => <option key={m} value={m} />)}
    </datalist> : null}
    {azure && <label className="st-row"><span className="st-row__label">{t('ai.endpoint.apiVersion')}</span>
      <Field mono aria-label={t('ai.endpoint.apiVersion')} placeholder="2024-06-01" autoComplete="off" spellCheck={false}
        value={v.apiVersion ?? ''} disabled={disabled} onChange={(e) => patch({ apiVersion: e.target.value })} /></label>}
    <details className="st-key">
      <summary><span>{t('ai.endpoint.title')} · {t('ai.endpoint.timeout')} / {t('ai.endpoint.headers')}</span></summary>
      <div className="st-key__body">
        <label className="st-row"><span className="st-row__label">{t('ai.endpoint.timeout')}</span>
          <Field mono type="number" min={1} max={600} aria-label={t('ai.endpoint.timeout')} placeholder="120" disabled={disabled}
            value={v.timeoutMs ? String(Math.round(v.timeoutMs / 1000)) : ''}
            onChange={(e) => patch({ timeoutMs: e.target.value ? Math.min(600, Math.max(1, Number(e.target.value))) * 1000 : undefined })} /></label>
        <label className="st-prompt"><span className="st-row__label">{t('ai.endpoint.headers')}</span>
          <textarea className="st-textarea" rows={2} aria-label={t('ai.endpoint.headers')} placeholder="HTTP-Referer: https://example.com" spellCheck={false} disabled={disabled}
            value={headerText} onChange={(e) => { setHeaderText(e.target.value); patch({ headers: parseHeaderLines(e.target.value) }) }} /></label>
        <p className="st-note">{t('ai.endpoint.headersHint')}</p>
      </div>
    </details>
    <div className="st-key__actions">
      <span className="st-note">{t('ai.endpoint.defaultHint')} {t('ai.endpoint.checkPricing')}</span>
      <Button variant="ghost" disabled={disabled || !value} onClick={() => { setHeaderText(''); onChange(undefined) }}>{t('ai.endpoint.reset')}</Button>
    </div>
  </div>
}

/** キーの出どころの表示。値そのものは renderer に来ない */
export function keyStateKey(source: SttAvailability['keys'][AiVendor], storage: SttAvailability['keyStorage']): TranslationKey {
  if (source === 'saved') return 'settings.capture.keySaved'
  if (source === 'session') return storage === 'encrypted' ? 'settings.capture.keySet' : 'settings.capture.keySessionOnly'
  if (source === 'env') return 'settings.capture.keyEnv'
  return 'settings.capture.keyNone'
}

/** 提供元（vendor）ごとのキー。保存・削除はその場で IPC へ送り、使える状態を読み直してもらう */
export function KeyField({ vendor, label, optional, placeholder, available, disabled, onChanged }: {
  vendor: AiVendor
  label: string
  optional: boolean
  placeholder: string
  available: SttAvailability
  disabled: boolean
  onChanged: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const source = available.keys[vendor]
  const title = t(optional ? 'ai.key.optional' : 'ai.key.label', { label })
  const run = (value: string) => {
    setBusy(true)
    void window.ade.invoke('capture:apiKey', value, vendor)
      .then((r) => { setKey(''); if (value) toast({ tone: 'success', message: t(r.persisted ? 'ai.key.saved' : 'ai.key.sessionOnly') }) })
      .catch((e: unknown) => toast({ tone: 'danger', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => { setBusy(false); onChanged() })
  }
  return <details className="st-key" open={!source || undefined}>
    <summary><KeyRound size={13} aria-hidden="true" /><span>{title}</span>{source && <span className="st-key__on" aria-hidden="true" />}</summary>
    <div className="st-key__body">
      <p className="st-note">{t(keyStateKey(source, available.keyStorage))} · {t('ai.key.shared', { label })}</p>
      <Field type="password" aria-label={title} placeholder={optional ? t('settings.capture.keyCompatiblePlaceholder') : placeholder || '…'} autoComplete="off"
        value={key} disabled={disabled || busy} onChange={(e) => setKey(e.target.value)} />
      <div className="st-key__actions">
        <Button variant="ghost" disabled={disabled || busy || (source !== 'saved' && source !== 'session')} onClick={() => run('')}>{t('settings.capture.keyDelete')}</Button>
        <Button busy={busy} disabled={disabled || !key.trim()} onClick={() => run(key.trim())}>{t(available.keyStorage === 'encrypted' ? 'settings.capture.keySave' : 'settings.capture.keySetSession')}</Button>
      </div>
      <p className="st-note">{t(available.keyStorage === 'encrypted' ? 'settings.capture.keyEncryptedNote' : 'settings.capture.keyPlainNote')}</p>
    </div>
  </details>
}

/** 「接続を確認」。結果は閉じるまでこの欄に出す */
export function CheckButton({ onCheck, disabled, note }: { onCheck: () => Promise<{ ok: boolean; message: string }>; disabled: boolean; note: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const check = () => {
    setBusy(true)
    setResult(null)
    void onCheck().then(setResult)
      .catch((e: unknown) => setResult({ ok: false, message: e instanceof Error ? e.message : t('settings.capture.testFailed') }))
      .finally(() => setBusy(false))
  }
  return <>
    <div className="st-key__actions">
      <Button variant="ghost" busy={busy} disabled={disabled} onClick={check} data-testid="ai-test-connection">{t('settings.capture.testConnection')}</Button>
    </div>
    {result && <p className={`st-note ${result.ok ? 'st-note--ok' : 'st-note--warn'}`} role="status">
      {result.ok ? <CircleCheck size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}{result.message}</p>}
    <p className="st-note">{note}</p>
  </>
}
