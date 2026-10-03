import { useState, type ReactNode } from 'react'
import { keyEnvHint } from '../lib/keyEnvHint'
import { Bot, ChevronRight, CircleAlert, CircleCheck, Copy, ExternalLink, KeyRound, Send } from 'lucide-react'
import {
  AI_PRESETS_VERIFIED_AT,
  currentModel,
  formatHeaderLines,
  parseHeaderLines,
  providerLabel,
  recommendedModel,
  selectModel,
  setupLayout,
  type AiEndpointConfig,
  type AiModelHint,
  type AiVendor,
  type LlmProviderPreset,
  type SttProviderPreset
} from '@shared/aiProviders'
import type { SttAvailability } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { Button, Field } from '../ui'
import { buildAgentSetupPrompt, setupLinks, type SetupGuide, type SetupLinkKind, type SetupPromptTarget } from '@shared/setupGuide'
import { setupCliTool } from '@shared/cliSetup'
import { CliAssist } from './CliAssist'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { useToast } from '../ui'

/**
 * 設定の文字起こし・整理の節（とオンボーディング）で共有する部品。
 * 簡単な経路は「提供元 → モデル → キー」の3段だけにし、利用者が AI を使う開発者向けの細かい設定
 * （Base URL・タイムアウト・追加のヘッダー・キーを読む環境変数）は「詳細」に畳む。
 */

// 「名前: 値」の行（値が ${VAR} なら環境変数から読む）。3つの接続先で同じ形（src/shared/aiProviders.ts）
export { formatHeaderLines, parseHeaderLines } from '@shared/aiProviders'

/** 上書きの空の項目を落とす（空ならプリセットを使う） */
export function compactEndpoint(cfg: AiEndpointConfig): AiEndpointConfig | undefined {
  const out: AiEndpointConfig = {}
  if (cfg.baseUrl?.trim()) out.baseUrl = cfg.baseUrl.trim()
  if (cfg.model?.trim()) out.model = cfg.model.trim()
  if (cfg.timeoutMs) out.timeoutMs = cfg.timeoutMs
  if (cfg.headers && Object.keys(cfg.headers).length) out.headers = cfg.headers
  if (cfg.apiVersion?.trim()) out.apiVersion = cfg.apiVersion.trim()
  // 空にしたことも main へ伝える（main は settings.json にあった apiKeyEnv を、届かなかったときだけ引き継ぐ）
  if (cfg.apiKeyEnv !== undefined) out.apiKeyEnv = cfg.apiKeyEnv.trim()
  // settings.json でだけ書ける項目（認証の形・Cloudflare のアカウント）は画面の保存で消さない
  if (cfg.authScheme) out.authScheme = cfg.authScheme
  if (cfg.authHeader) out.authHeader = cfg.authHeader
  if (cfg.accountId?.trim()) out.accountId = cfg.accountId.trim()
  return Object.keys(out).length ? out : undefined
}

/** モデルの一言の説明の文言 */
const HINT_KEY: Record<AiModelHint, TranslationKey> = {
  balanced: 'ai.hint.balanced', fast: 'ai.hint.fast', cheap: 'ai.hint.cheap', accurate: 'ai.hint.accurate', best: 'ai.hint.best',
  speakers: 'ai.hint.speakers', timestamps: 'ai.hint.timestamps', local: 'ai.hint.local', pinned: 'ai.hint.pinned', retiring: 'ai.hint.retiring'
}

type Preset = (SttProviderPreset | LlmProviderPreset)

/**
 * 提供元の設定の簡単な経路：② モデル（推奨を選んだ状態の一覧）→ ③ API キー（欄1つと「キーを取得」「確認」）。
 * Custom・Azure・Cloudflare だけは Base URL（と一覧の無いモデル名）を外に出す。
 * ほかの項目（タイムアウト・ヘッダー・認証・費用の上限・プリセットに戻す）は「詳細」に畳む（オンボーディングでは描かない）。
 * 値は settings.json と同じ AiEndpointConfig を読み書きする（画面の簡単な経路と JSON の完全な設定は同じデータ）。
 */
export function ProviderSetup({ preset, value, onChange, available, onAvailabilityChange, onCheck, disabled, onboarding = false, advancedExtra, setupTarget, testId }: {
  preset: Preset
  value: AiEndpointConfig | undefined
  onChange: (next: AiEndpointConfig | undefined) => void
  available: SttAvailability
  onAvailabilityChange: () => void
  /** 「確認」を押したときだけ呼ぶ（自動では送らない） */
  onCheck: () => Promise<{ ok: boolean; message: string }>
  disabled: boolean
  onboarding?: boolean
  /** 詳細に足す行（文字起こしの費用の上限など） */
  advancedExtra?: ReactNode
  /** 「Agent に設定を頼む」の指示文の宛先（settings.json の中の場所など）。無ければ出さない */
  setupTarget?: Omit<SetupPromptTarget, 'settingsPath' | 'envPath'>
  testId?: string
}) {
  const t = useT()
  const layout = setupLayout(preset, { onboarding })
  const label = providerLabel(preset, t)
  // リンクと指示文の元（プリセットにある案内の情報）
  const guide: SetupGuide = { ...preset, label }
  const azure = 'kind' in preset && preset.kind === 'azure-openai'
  const patch = (p: Partial<AiEndpointConfig>) => onChange(compactEndpoint({ ...value, ...p }))
  return <div className="st-endpoint" data-testid={testId}>
    {layout.baseUrlField && <label className="st-row"><span className="st-row__label">{t('ai.endpoint.baseUrl')}</span>
      <Field mono aria-label={t('ai.endpoint.baseUrl')} placeholder={preset.baseUrlPlaceholder || preset.baseUrl || 'https://…'} autoComplete="off" spellCheck={false}
        value={value?.baseUrl ?? ''} disabled={disabled} onChange={(e) => patch({ baseUrl: e.target.value })} data-testid="ai-base-url" /></label>}
    {layout.accountIdField && <label className="st-row"><span className="st-row__label">{t('ai.endpoint.accountId')}</span>
      <Field mono aria-label={t('ai.endpoint.accountId')} placeholder="CLOUDFLARE_ACCOUNT_ID" autoComplete="off" spellCheck={false}
        value={value?.accountId ?? ''} disabled={disabled} onChange={(e) => patch({ accountId: e.target.value.trim() || undefined })} data-testid="ai-account-id" /></label>}
    {layout.accountIdField && <div className="st-key__actions"><GuideLinks guide={guide} kinds={['id']} /></div>}
    <ModelStep preset={preset} value={value} onChange={onChange} disabled={disabled} label={t(azure ? 'ai.endpoint.deployment' : 'ai.endpoint.model')} />
    {layout.keyField && <KeyStep vendor={preset.vendor} label={label} optional={!preset.keyRequired} placeholder={preset.keyPlaceholder}
      links={<GuideLinks guide={guide} kinds={['key', 'docs']} />} available={available} disabled={disabled} onChanged={onAvailabilityChange} onCheck={onCheck} />}
    {/* 端末内のサーバーにはキーが無いので、インストールのページと確認だけを出す */}
    {!layout.keyField && <div className="st-key__actions"><GuideLinks guide={guide} kinds={['install', 'docs']} /><CheckMark onCheck={onCheck} disabled={disabled} /></div>}
    {setupTarget && <AskAgent guide={guide} target={setupTarget} disabled={disabled} />}
    {layout.advanced
      ? <AdvancedFields preset={preset} value={value} onChange={onChange} disabled={disabled} azure={azure} showBaseUrl={!layout.baseUrlField}
          available={available} onAvailabilityChange={onAvailabilityChange} extra={advancedExtra} />
      : <p className="st-note" data-testid="ai-more-options">{t('ai.onboarding.moreOptions')}</p>}
  </div>
}

/** ② モデル。一覧のある提供元は選択（推奨を選んだ状態、各行に一言の説明）、無いもの（Custom など）は自由入力 */
export function ModelStep({ preset, value, onChange, disabled, label }: {
  preset: Preset
  value: AiEndpointConfig | undefined
  onChange: (next: AiEndpointConfig | undefined) => void
  disabled: boolean
  label: string
}) {
  const t = useT()
  const current = currentModel(preset, value)
  if (setupLayout(preset, { onboarding: false }).modelField === 'text') {
    return <label className="st-row"><span className="st-row__label">{label}</span>
      <Field mono aria-label={label} placeholder={preset.model || 'model-name'} autoComplete="off" spellCheck={false} disabled={disabled}
        value={value?.model ?? ''} onChange={(e) => onChange(selectModel(preset, value, e.target.value))} data-testid="ai-model-text" /></label>
  }
  // 詳細や settings.json で一覧にないモデル名を入れていたら、それも選択肢に残す
  const custom = preset.models.some((m) => m.id === current) ? null : current
  // 一言の説明と料金まで読めるよう、ラベルの下に幅いっぱいで出す
  return <label className="st-row st-row--stack"><span className="st-row__label">{label}</span><span className="rv-select">
    <select className="st-select" aria-label={label} value={current} disabled={disabled} onChange={(e) => onChange(selectModel(preset, value, e.target.value))} data-testid="ai-model">
      {preset.models.map((m) => <option key={m.id} value={m.id}>
        {m.id} — {t(HINT_KEY[m.hint])}{m.price ? ` · ${m.price}` : ''}{m.recommended ? ` · ${t('ai.model.recommended')}` : ''}
      </option>)}
      {custom && <option value={custom}>{custom} — {t('ai.model.custom')}</option>}
    </select></span></label>
}

/**
 * ③ API キー。欄1つ・「キーを取得」のリンク・「確認」だけ。
 * 欄から離れたときに保存する（形の誤りはその場で出す）。確認は押したときだけ送り、✓ か ✗ を小さく出す。
 */
export function KeyStep({ vendor, label, optional, placeholder, links, available, disabled, onChanged, onCheck }: {
  vendor: AiVendor
  label: string
  optional: boolean
  placeholder: string
  /** 「キーを作る ↗」「ドキュメント ↗」のリンク */
  links?: ReactNode
  available: SttAvailability
  disabled: boolean
  onChanged: () => void
  onCheck: () => Promise<{ ok: boolean; message: string }>
}) {
  const t = useT()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 開発版では .env の OPENAI_API_KEY を使うことがある。保存したキーと分けて見せる
  const source = available.keys[vendor]
  const title = t(optional ? 'ai.key.optional' : 'ai.key.label', { label })
  const save = () => {
    const value = key.trim()
    if (!value) return
    void window.ade.invoke('capture:apiKey', value, vendor)
      .then(() => { setKey(''); setError(null) })
      // main の例外は IPC の前置き（Error invoking remote method …）付きで届くので、本文だけにする
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(onChanged)
  }
  return <div className="st-keystep">
    <label className="st-row"><span className="st-row__label">{t('ai.key.short')}</span>
      <Field type="password" aria-label={title} autoComplete="off" disabled={disabled} value={key} invalid={!!error} data-testid="ai-key"
        placeholder={source === 'env' ? t('settings.capture.keyEnv') : source ? t('ai.key.savedPlaceholder') : optional ? t('settings.capture.keyCompatiblePlaceholder') : placeholder || '…'}
        onChange={(e) => { setKey(e.target.value); setError(null) }} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save() }} /></label>
    {error && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{error}</p>}
    <div className="st-key__actions">
      {links}
      <CheckMark onCheck={onCheck} disabled={disabled} />
    </div>
  </div>
}

const LINK_LABEL: Record<SetupLinkKind, TranslationKey> = { key: 'ai.setup.link.key', id: 'ai.setup.link.id', docs: 'ai.setup.link.docs', install: 'ai.setup.link.install' }

/**
 * 「キーを作る ↗」「ID はここ ↗」などのリンク。外部のブラウザで開く（main の app:openExternal が https だけを開く）。
 * 判定モデルの欄からも使えるよう export する
 */
export function GuideLinks({ guide, kinds }: { guide: SetupGuide; kinds: readonly SetupLinkKind[] }) {
  const t = useT()
  const toast = useToast()
  // 入れ方が CLI で済むもの（Ollama）は、ダウンロードのページへのリンクを出さない（AskAgent の上の行でターミナルから入れる）
  const cliInstall = setupCliTool(guide) !== null
  const links = setupLinks(guide).filter((l) => kinds.includes(l.kind) && !(l.kind === 'install' && cliInstall))
  if (!links.length) return null
  return <span className="st-links">
    {links.map((l) => <button key={l.kind} type="button" className="st-link" data-testid={`ai-link-${l.kind}`} title={l.url}
      onClick={() => void window.ade.invoke('app:openExternal', l.url).catch((e: unknown) => toast({ tone: 'danger', message: errorMessage(e) }))}>
      <ExternalLink size={12} aria-hidden="true" />{t(LINK_LABEL[l.kind])}
    </button>)}
  </span>
}

/**
 * 「Agent に設定を頼む」。CLI を入れる・Account ID を調べる・キーを用意する・settings.json と .env に書く・確かめる、を Agent に全部頼む指示文を
 * コピーするか、Agent のターミナルへ送る。指示文にキーや ID の値は入らない（src/shared/setupGuide.ts）。
 * 判定モデルの欄からも使えるよう export する
 */
export function AskAgent({ guide, target, disabled }: { guide: SetupGuide; target: Omit<SetupPromptTarget, 'settingsPath' | 'envPath'>; disabled: boolean }) {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  /** settings.json の場所は、開くたびに main から読む（dev・FERRET_CONFIG_DIR で変わるため） */
  const prompt = async () => {
    const info = await window.ade.invoke('settingsFile:info')
    const sep = info.dir.includes('\\') ? '\\' : '/'
    return buildAgentSetupPrompt(guide, { ...target, settingsPath: info.path, schemaPath: info.schemaPath, envPath: `${info.dir}${sep}.env` }, t)
  }
  const run = (action: () => Promise<void>) => {
    setBusy(true)
    void action().catch((e: unknown) => toast({ tone: 'danger', message: errorMessage(e) })).finally(() => setBusy(false))
  }
  // 設定に役立つ CLI（Cloudflare は wrangler、Ollama は本体）を、その場でターミナルから入れる・ログインする行
  const cliTool = setupCliTool(guide)
  return <>{cliTool && <CliAssist tool={cliTool} />}<details className="st-key st-advanced" data-testid="ai-ask-agent">
    <summary><Bot size={13} aria-hidden="true" /><span>{t('ai.setup.askAgent')}</span></summary>
    <div className="st-key__body">
      <p className="st-note">{t('ai.setup.note')}</p>
      <div className="st-key__actions">
        <Button variant="ghost" icon={<Copy size={13} />} disabled={disabled || busy} data-testid="ai-ask-copy" onClick={() => run(async () => {
          await navigator.clipboard.writeText(await prompt())
          toast({ tone: 'success', message: t('ai.setup.copied') })
        })}>{t('ai.setup.copy')}</Button>
        <Button icon={<Send size={13} />} busy={busy} disabled={disabled} data-testid="ai-ask-send" onClick={() => run(async () => {
          const r = await window.ade.invoke('agent:sendText', await prompt())
          toast(r.ok ? { tone: 'success', message: t('ai.setup.sent') } : { tone: 'danger', message: r.message })
        })}>{t('ai.setup.send')}</Button>
      </div>
    </div>
  </details></>
}

/** 「確認」。押したときだけ送り、✓ か ✗（と理由）を小さく出す */
function CheckMark({ onCheck, disabled }: { onCheck: () => Promise<{ ok: boolean; message: string }>; disabled: boolean }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  return <span className="st-check">
    <Button variant="ghost" busy={busy} disabled={disabled} data-testid="ai-check" onClick={() => {
      setBusy(true)
      setResult(null)
      void onCheck().then(setResult)
        .catch((e: unknown) => setResult({ ok: false, message: errorMessage(e) || t('settings.capture.testFailed') }))
        .finally(() => setBusy(false))
    }}>{t('ai.key.check')}</Button>
    {result?.ok && <span className="st-note st-note--ok" role="status" title={result.message}><CircleCheck size={12} aria-label={result.message} /></span>}
    {result && !result.ok && <span className="st-note st-note--warn" role="status"><CircleAlert size={12} aria-hidden="true" />{result.message}</span>}
  </span>
}

/**
 * 「詳細」（既定で閉じる）。settings.json の項目をそのまま編集する：Base URL・モデル名の直接入力・api-version（Azure）・
 * タイムアウト・追加のヘッダー・キーを読む環境変数・費用の上限など（extra）・保存したキーの削除・プリセットに戻す。
 * 閉じていても値は消さない（提供元を切り替えても、提供元ごとに残る）。
 */
export function AdvancedFields({ preset, value, onChange, disabled, azure, showBaseUrl, available, onAvailabilityChange, extra }: {
  preset: Preset
  value: AiEndpointConfig | undefined
  onChange: (next: AiEndpointConfig | undefined) => void
  disabled: boolean
  azure: boolean
  /** Base URL が外に出ていなければ、ここに出す */
  showBaseUrl: boolean
  available: SttAvailability
  onAvailabilityChange: () => void
  extra?: ReactNode
}) {
  const t = useT()
  const v = value ?? {}
  // ヘッダーは入力中の崩れた行も残したいので、文字列のまま持つ
  const [headerText, setHeaderText] = useState(() => formatHeaderLines(v.headers))
  const patch = (p: Partial<AiEndpointConfig>) => onChange(compactEndpoint({ ...v, ...p }))
  const source = available.keys[preset.vendor]
  return <details className="st-key st-advanced" data-testid="ai-advanced">
    <summary><ChevronRight size={13} aria-hidden="true" className="st-advanced__chevron" /><span>{t('ai.advanced.title')}</span></summary>
    <div className="st-key__body">
      {showBaseUrl && <label className="st-row"><span className="st-row__label">{t('ai.endpoint.baseUrl')}</span>
        <Field mono aria-label={t('ai.endpoint.baseUrl')} placeholder={preset.baseUrl || 'https://…'} autoComplete="off" spellCheck={false}
          value={v.baseUrl ?? ''} disabled={disabled} onChange={(e) => patch({ baseUrl: e.target.value })} /></label>}
      {preset.models.length > 0 && <label className="st-row"><span className="st-row__label">{t('ai.advanced.modelOverride')}</span>
        <Field mono aria-label={t('ai.advanced.modelOverride')} placeholder={recommendedModel(preset)} autoComplete="off" spellCheck={false}
          value={v.model ?? ''} disabled={disabled} onChange={(e) => patch({ model: e.target.value })} /></label>}
      {azure && <label className="st-row"><span className="st-row__label">{t('ai.endpoint.apiVersion')}</span>
        <Field mono aria-label={t('ai.endpoint.apiVersion')} placeholder="2024-06-01" autoComplete="off" spellCheck={false}
          value={v.apiVersion ?? ''} disabled={disabled} onChange={(e) => patch({ apiVersion: e.target.value })} /></label>}
      <label className="st-row"><span className="st-row__label">{t('ai.endpoint.timeout')}</span>
        <Field mono type="number" min={1} max={600} aria-label={t('ai.endpoint.timeout')} placeholder="120" disabled={disabled}
          value={v.timeoutMs ? String(Math.round(v.timeoutMs / 1000)) : ''}
          onChange={(e) => patch({ timeoutMs: e.target.value ? Math.min(600, Math.max(1, Number(e.target.value))) * 1000 : undefined })} /></label>
      <label className="st-prompt"><span className="st-row__label">{t('ai.endpoint.headers')}</span>
        <textarea className="st-textarea" rows={2} aria-label={t('ai.endpoint.headers')} placeholder="HTTP-Referer: https://example.com" spellCheck={false} disabled={disabled}
          value={headerText} onChange={(e) => { setHeaderText(e.target.value); patch({ headers: parseHeaderLines(e.target.value) }) }} /></label>
      <p className="st-note">{t('ai.endpoint.headersHint')}</p>
      <label className="st-row"><span className="st-row__label">{t('ai.endpoint.apiKeyEnv')}</span>
        <Field mono aria-label={t('ai.endpoint.apiKeyEnv')} placeholder="OPENAI_API_KEY" autoComplete="off" spellCheck={false} disabled={disabled}
          value={v.apiKeyEnv ?? ''} onChange={(e) => patch({ apiKeyEnv: e.target.value })} /></label>
      <p className="st-note">{t('ai.endpoint.apiKeyEnvHint')}</p>
      {/* 認証の形（社内プロキシなど）。既定は提供元ごとの形。ヘッダーの値は「名前: ${VAR}」で環境変数から読める（{ env }） */}
      <label className="st-row"><span className="st-row__label">{t('ai.advanced.authScheme')}</span><span className="rv-select">
        <select className="st-select" aria-label={t('ai.advanced.authScheme')} value={v.authScheme ?? ''} disabled={disabled}
          onChange={(e) => patch({ authScheme: (e.target.value || undefined) as AiEndpointConfig['authScheme'] })}>
          <option value="">{t('ai.advanced.authDefault')}</option>
          <option value="bearer">Authorization: Bearer</option>
          <option value="header">{t('ai.advanced.authHeader')}</option>
          <option value="none">{t('ai.advanced.authNone')}</option>
        </select></span></label>
      {v.authScheme === 'header' && <label className="st-row"><span className="st-row__label">{t('ai.advanced.authHeaderName')}</span>
        <Field mono aria-label={t('ai.advanced.authHeaderName')} placeholder="x-api-key" autoComplete="off" spellCheck={false} disabled={disabled}
          value={v.authHeader ?? ''} onChange={(e) => patch({ authHeader: e.target.value.trim() || undefined })} /></label>}
      {extra}
      <p className="st-note">{t(keyStateKey(source, available.keyStorage))} · {t(available.keyStorage === 'encrypted' ? 'settings.capture.keyEncryptedNote' : available.keyStorage === 'dev' ? 'settings.capture.keyDevNote' : 'settings.capture.keyPlainNote')}
        {/* 実際に読まれる環境変数の名前だけを案内する（提供元ごと。lib/keyEnvHint.ts） */}
        {(() => { const env = keyEnvHint(preset.vendor, v.apiKeyEnv, available.keyStorage); return env ? ` ${t('ai.key.envHint', { env })}` : '' })()}</p>
      <div className="st-key__actions">
        <Button variant="ghost" disabled={disabled || (source !== 'saved' && source !== 'session')}
          onClick={() => void window.ade.invoke('capture:apiKey', '', preset.vendor).finally(onAvailabilityChange)}>{t('settings.capture.keyDelete')}</Button>
        <Button variant="ghost" disabled={disabled || !value} onClick={() => { setHeaderText(''); onChange(undefined) }}>{t('ai.endpoint.reset')}</Button>
      </div>
      <p className="st-note">{t('ai.endpoint.checkPricing')} ({AI_PRESETS_VERIFIED_AT})</p>
    </div>
  </details>
}

/** キーの出どころの表示。値そのものは renderer に来ない */
export function keyStateKey(source: SttAvailability['keys'][AiVendor], storage: SttAvailability['keyStorage']): TranslationKey {
  if (source === 'saved') return 'settings.capture.keySaved'
  if (source === 'session') return storage === 'encrypted' ? 'settings.capture.keySet' : 'settings.capture.keySessionOnly'
  if (source === 'env') return 'settings.capture.keyEnv'
  if (source === 'config') return 'settings.capture.keyConfig'
  if (source === 'configEnv') return 'settings.capture.keyConfigEnv'
  return 'settings.capture.keyNone'
}

/** 提供元（vendor）ごとのキー。保存・削除はその場で IPC へ送り、使える状態を読み直してもらう */
export function KeyField({ vendor, label, optional, placeholder, available, disabled, onChanged, envVar }: {
  vendor: AiVendor
  label: string
  optional: boolean
  placeholder: string
  available: SttAvailability
  disabled: boolean
  onChanged: () => void
  /** 設定の apiKeyEnv（書いてあれば、その名前を「この環境変数も使えます」として出す） */
  envVar?: string
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
      .catch((e: unknown) => toast({ tone: 'danger', message: errorMessage(e) }))
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
      <p className="st-note">{t(available.keyStorage === 'encrypted' ? 'settings.capture.keyEncryptedNote' : available.keyStorage === 'dev' ? 'settings.capture.keyDevNote' : 'settings.capture.keyPlainNote')}
        {(() => { const env = keyEnvHint(vendor, envVar, available.keyStorage); return env ? ` ${t('ai.key.envHint', { env })}` : '' })()}</p>
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
      .catch((e: unknown) => setResult({ ok: false, message: errorMessage(e) || t('settings.capture.testFailed') }))
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
