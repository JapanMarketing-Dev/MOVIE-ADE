import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Cloud, Copy, ExternalLink, FolderOpen, Laptop, Mic, MonitorUp, RefreshCw, Server } from 'lucide-react'
import type { AgentOption, AgentPreferences, BuiltinAgent, Project, ProjectsState, ProjectUrl, SttAvailability, SttProvider } from '@shared/types'
import { AGENT_CATALOG, isBuiltinAgent } from '@shared/agentCatalog'
import { isPresetableUrl } from '@shared/projectUrl'
import { LOCALE_LABELS, LOCALE_PREFERENCES, type LocalePreference, type TranslationKey } from '@shared/i18n'
import type { MediaAccessStatus, PermissionKind, PermissionsState } from '@shared/onboarding'
import { Button, Field, IconButton, RecordButton, Segmented, ThemeSegmented, useToast } from '../ui'
import { useLocalePreference, useT } from '../lib/i18n'
import { SHORTCUTS, formatShortcut } from '../lib/shortcut'
import { setAgentEnabled, toggleStartupAgent } from '../lib/agentPrefs'
import { errorMessage } from '../lib/errors'
import { AgentIcon } from '../components/AgentIcon'
import { TranscriptionSection, type SpeechLanguageValue } from '../components/TranscriptionSection'
import { CrashReportsSetting } from '../components/CrashReportsSetting'
import { AGENT_INSTALL_COMMANDS } from './agentInstall'
import { voiceModeOf, type VoiceMode } from './onboardingFlowState'

/**
 * セットアップの各手順の中身。設定の保存は既存の経路（lib/theme・lib/i18n・settings:agents・project:*・
 * 文字起こしの節・settings:crashReports）をそのまま使い、ここで新しい設定は持たない。
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/ThemeStep.tsx・AgentStep.tsx の
 *           「選ぶとすぐ反映」「検出済みを先に並べ、無いものには入れ方を出す」使い心地（MIT）。
 */

// ───────────────────────── 見た目（配色・言語） ─────────────────────────

export function AppearanceStep() {
  const t = useT()
  const [locale, setLocale] = useLocalePreference()
  const localeOptions = LOCALE_PREFERENCES.map((value) => ({
    value,
    label: value === 'system' ? t('settings.language.system') : LOCALE_LABELS[value],
    testId: `onboarding-locale-${value}`
  }))
  return <div className="ob-stack">
    <div className="ob-field">
      <span className="ob-field__label">{t('onboarding.appearance.theme')}</span>
      <ThemeSegmented />
    </div>
    <div className="ob-field">
      <span className="ob-field__label">{t('onboarding.appearance.language')}</span>
      <Segmented<LocalePreference> options={localeOptions} value={locale} onChange={setLocale} ariaLabel={t('onboarding.appearance.language')} />
    </div>
    {/* 配色は画面全体にすぐ効く。代表的な部品だけを並べた見本 */}
    <figure className="ob-preview" aria-label={t('onboarding.appearance.preview')}>
      <figcaption className="ob-field__label">{t('onboarding.appearance.preview')}</figcaption>
      <div className="ob-preview__window">
        <div className="ob-preview__bar"><span className="ob-preview__dot" /><span className="ob-preview__dot" /><span className="ob-preview__dot" /><span className="ob-preview__url">localhost:3000/checkout</span></div>
        <div className="ob-preview__body">
          <div className="ob-preview__page">
            <strong>{t('onboarding.appearance.previewTitle')}</strong>
            <p>{t('onboarding.appearance.previewText')}</p>
          </div>
          <div className="ob-preview__actions">
            <RecordButton recording={false} onClick={() => undefined} />
            <Button variant="primary">{t('onboarding.appearance.previewSend')}</Button>
          </div>
        </div>
      </div>
    </figure>
  </div>
}

// ───────────────────────── Agent ─────────────────────────

export function AgentsStep({ agents, onAgentsChange }: { agents: AgentPreferences; onAgentsChange: (next: AgentPreferences) => void }) {
  const t = useT()
  const toast = useToast()
  const [options, setOptions] = useState<AgentOption[] | null>(null)
  const detect = useCallback((refresh: boolean) => {
    setOptions(null)
    void window.ade.invoke('agents:list', refresh).then(setOptions).catch(() => setOptions([]))
  }, [])
  // PATH を読み直して探す（Orca も手順を開いたときに検出し直す）
  useEffect(() => detect(true), [detect])

  const builtins = (options ?? []).filter((o): o is AgentOption & { id: BuiltinAgent } => !o.custom && isBuiltinAgent(o.id))
  // 見つかったものを先に（並びはカタログの順のまま）
  const sorted = [...builtins.filter((o) => o.installed), ...builtins.filter((o) => !o.installed)]
  const toggle = (id: BuiltinAgent, on: boolean) => {
    const enabled = on ? setAgentEnabled(agents, id, true) : agents
    onAgentsChange(toggleStartupAgent(enabled, id, on))
  }
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast({ tone: 'success', message: t('common.copied') }), () => {})
  const missingSelected = agents.startupAgents.some((id) => builtins.some((o) => o.id === id && !o.installed))

  return <div className="ob-stack">
    {options === null
      ? <p className="ob-note" role="status">{t('onboarding.agents.detecting')}</p>
      : <div className="ob-agents" role="group" aria-label={t('onboarding.agents.title')}>
        {sorted.map((option) => {
          const order = agents.startupAgents.indexOf(option.id)
          const install = AGENT_INSTALL_COMMANDS[option.id]
          return <div key={option.id} className="ob-agent" data-checked={order >= 0 || undefined} data-testid={`onboarding-agent-${option.id}`}>
            <label className="ob-agent__head">
              <input type="checkbox" checked={order >= 0} onChange={(e) => toggle(option.id, e.target.checked)}
                aria-label={t('onboarding.agents.autoLaunch', { agent: option.label })} />
              <AgentIcon agent={option.id} label={option.label} size={16} />
              <span className="ob-agent__name">{option.label}</span>
              {order >= 0 && <span className="ob-agent__order" aria-hidden="true">{order + 1}</span>}
            </label>
            {option.installed
              ? <span className="ob-agent__state is-ok"><CircleCheck size={12} aria-hidden="true" />{t('onboarding.agents.installed')}</span>
              : <div className="ob-agent__missing">
                <span className="ob-agent__state"><CircleAlert size={12} aria-hidden="true" />{t('onboarding.agents.notFound')}</span>
                {install && <span className="ob-agent__install">
                  <code title={install}>{install}</code>
                  <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={13} />} onClick={() => copy(install)} />
                </span>}
                <a className="ob-link" href={AGENT_CATALOG[option.id].homepageUrl} target="_blank" rel="noreferrer">
                  {t('onboarding.agents.installGuide')}<ExternalLink size={11} aria-hidden="true" /></a>
              </div>}
          </div>
        })}
      </div>}
    <div className="ob-row">
      <p className={`ob-note${missingSelected ? ' ob-note--warn' : ''}`}>
        {t(agents.startupAgents.length === 0 ? 'onboarding.agents.noneSelected' : missingSelected ? 'onboarding.agents.missingSelected' : 'onboarding.agents.more')}
      </p>
      <Button variant="ghost" icon={<RefreshCw size={13} />} disabled={options === null} onClick={() => detect(true)}>{t('onboarding.agents.recheck')}</Button>
    </div>
  </div>
}

// ───────────────────────── プロジェクト ─────────────────────────

/** 登録するURLの欄。ラベルは local / dev / prd に固定する（ツールバーのURLプリセットと同じ並び） */
const URL_PRESETS = [
  { label: 'local', placeholder: 'http://localhost:3000' },
  { label: 'dev', placeholder: 'https://dev.example.com' },
  { label: 'prd', placeholder: 'https://example.com' }
] as const

export function ProjectStep({ projects }: { projects: ProjectsState }) {
  const t = useT()
  const toast = useToast()
  const project = projects.projects.find((p) => p.id === projects.activeProjectId) ?? projects.projects[projects.projects.length - 1] ?? null
  const add = () => void window.ade.invoke('project:add').catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  return <div className="ob-stack">
    <div className="ob-row ob-row--start">
      <Button variant={project ? 'default' : 'primary'} icon={<FolderOpen size={14} />} onClick={add} data-testid="onboarding-project-add">
        {t(project ? 'onboarding.project.addAnother' : 'onboarding.project.choose')}</Button>
    </div>
    {project
      ? <ProjectUrls key={project.id} project={project} />
      : <p className="ob-note">{t('onboarding.project.none')}</p>}
  </div>
}

function ProjectUrls({ project }: { project: Project }) {
  const t = useT()
  const toast = useToast()
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(URL_PRESETS.map(({ label }) => [label, project.urls.find((u) => u.label === label)?.url ?? ''])))

  /** 欄を離れたときに保存する。空なら外し、形の崩れたURLは保存しない */
  const commit = (label: string) => {
    const url = (drafts[label] ?? '').trim()
    if (url && !isPresetableUrl(url)) return
    const existing = project.urls.find((u) => u.label === label)
    if ((existing?.url ?? '') === url) return
    const urls: ProjectUrl[] = url
      ? existing ? project.urls.map((u) => (u.id === existing.id ? { ...u, url } : u)) : [...project.urls, { id: crypto.randomUUID(), label, url }]
      : project.urls.filter((u) => u.label !== label)
    void window.ade.invoke('project:update', { ...project, urls }).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  return <div className="ob-card">
    <div className="ob-card__head">
      <FolderOpen size={14} aria-hidden="true" />
      <span className="ob-card__title">{project.name}</span>
      <code className="ob-card__path" title={project.folderPath}>{project.folderPath}</code>
    </div>
    <span className="ob-field__label">{t('onboarding.project.urls')}</span>
    {URL_PRESETS.map(({ label, placeholder }) => {
      const value = drafts[label] ?? ''
      const invalid = value.trim() !== '' && !isPresetableUrl(value.trim())
      return <label key={label} className="ob-url">
        <span className="ob-url__label">{label}</span>
        <Field mono placeholder={placeholder} aria-label={`${t('onboarding.project.urls')} ${label}`} autoComplete="off" spellCheck={false}
          value={value} aria-invalid={invalid || undefined} data-testid={`onboarding-url-${label}`}
          onChange={(e) => setDrafts((prev) => ({ ...prev, [label]: e.target.value }))} onBlur={() => commit(label)} />
      </label>
    })}
    {URL_PRESETS.some(({ label }) => (drafts[label] ?? '').trim() && !isPresetableUrl((drafts[label] ?? '').trim()))
      ? <p className="ob-note ob-note--warn">{t('onboarding.project.urlInvalid')}</p>
      : <p className="ob-note">{t('onboarding.project.urlsHint')}</p>}
  </div>
}

// ───────────────────────── 文字起こし（BYOK） ─────────────────────────

export interface OnboardingVoice {
  transcription: SttProvider
  language: SpeechLanguageValue
  available: SttAvailability
  onTranscriptionChange: (next: SttProvider) => void
  onLanguageChange: (next: SpeechLanguageValue) => void
  onAvailabilityChange: () => void
  onPickModel: () => void
  onModelChanged: () => void
}

const VOICE_MODES: ReadonlyArray<{ mode: VoiceMode; provider: SttProvider; icon: typeof Laptop }> = [
  { mode: 'local', provider: 'local', icon: Laptop },
  { mode: 'cloud', provider: 'openai', icon: Cloud },
  { mode: 'selfHosted', provider: 'compatible', icon: Server }
]

export function VoiceStep({ voice }: { voice: OnboardingVoice }) {
  const t = useT()
  const current = voiceModeOf(voice.transcription)
  return <div className="ob-stack">
    <div className="ob-tiles" role="radiogroup" aria-label={t('onboarding.voice.title')}>
      {VOICE_MODES.map(({ mode, provider, icon: Icon }) => (
        <button key={mode} type="button" role="radio" aria-checked={current === mode} className="ob-tile" data-testid={`onboarding-voice-${mode}`}
          // 同じ使い方の中で選び直した提供元（Groq など）は、もう一度押しても戻さない
          onClick={() => { if (current !== mode) voice.onTranscriptionChange(provider) }}>
          <Icon size={16} aria-hidden="true" />
          <span className="ob-tile__title">{t(`onboarding.voice.${mode}` as TranslationKey)}</span>
          <span className="ob-tile__hint">{t(`onboarding.voice.${mode}Hint` as TranslationKey)}</span>
        </button>
      ))}
    </div>
    <p className="ob-note">{t('onboarding.voice.byok')}</p>
    {/* 言語・提供元・接続先・キー・接続の確認・モデルのダウンロードは、設定と同じ部品を使う */}
    <div className="ob-card">
      <TranscriptionSection headless transcription={voice.transcription} onTranscriptionChange={voice.onTranscriptionChange}
        language={voice.language} onLanguageChange={voice.onLanguageChange} recording={false} available={voice.available}
        onAvailabilityChange={voice.onAvailabilityChange} onPickModel={voice.onPickModel} onModelChanged={voice.onModelChanged} />
    </div>
  </div>
}

// ───────────────────────── 許可 ─────────────────────────

const STATUS_KEY: Record<MediaAccessStatus, TranslationKey> = {
  granted: 'onboarding.permissions.status.granted',
  denied: 'onboarding.permissions.status.denied',
  'not-determined': 'onboarding.permissions.status.not-determined',
  restricted: 'onboarding.permissions.status.restricted',
  unknown: 'onboarding.permissions.status.unknown'
}

export function PermissionsStep() {
  const t = useT()
  const [state, setState] = useState<PermissionsState | null>(null)
  const [busy, setBusy] = useState<PermissionKind | null>(null)
  // 読むだけ（確認のダイアログは出ない）。システム設定から戻ってきたら読み直す
  useEffect(() => {
    const read = () => void window.ade.invoke('permissions:status').then(setState).catch(() => undefined)
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [])
  const request = (kind: PermissionKind) => {
    setBusy(kind)
    void window.ade.invoke('permissions:request', kind).then(setState).catch(() => undefined).finally(() => setBusy(null))
  }
  const mac = window.ade.platform === 'darwin'
  const rows: ReadonlyArray<{ kind: PermissionKind; icon: typeof Mic; title: TranslationKey; hint: TranslationKey }> = [
    { kind: 'microphone', icon: Mic, title: 'onboarding.permissions.mic', hint: 'onboarding.permissions.micHint' },
    { kind: 'screen', icon: MonitorUp, title: 'onboarding.permissions.screen', hint: 'onboarding.permissions.screenHint' }
  ]
  return <div className="ob-stack">
    {!mac && <p className="ob-note ob-note--ok"><CircleCheck size={12} aria-hidden="true" />{t('onboarding.permissions.notNeeded')}</p>}
    {rows.map(({ kind, icon: Icon, title, hint }) => {
      const status = state?.[kind] ?? 'unknown'
      const granted = status === 'granted'
      // マイクは未確認なら OS の確認を出せる。断った後と画面収録はシステム設定を開く
      const label = kind === 'microphone' && status === 'not-determined' ? 'onboarding.permissions.allowMic' : 'onboarding.permissions.openSettings'
      return <div key={kind} className="ob-perm" data-testid={`onboarding-permission-${kind}`}>
        <Icon size={16} aria-hidden="true" />
        <div className="ob-perm__text">
          <span className="ob-perm__title">{t(title)}</span>
          <span className="ob-note">{t(hint)}</span>
          {(status === 'denied' || status === 'restricted') && <span className="ob-note ob-note--warn">{t('onboarding.permissions.deniedHint')}</span>}
          {kind === 'screen' && mac && !granted && <span className="ob-note">{t('onboarding.permissions.screenRestart')}</span>}
        </div>
        <span className={`ob-perm__state${granted ? ' is-ok' : ''}`}>{state ? t(STATUS_KEY[status]) : ''}</span>
        {mac && !granted && <Button busy={busy === kind} onClick={() => request(kind)} data-testid={`onboarding-permission-${kind}-request`}>{t(label)}</Button>}
      </div>
    })}
  </div>
}

// ───────────────────────── 完了 ─────────────────────────

export function FinishStep() {
  const t = useT()
  const record = formatShortcut('Mod', 'Shift', 'R')
  const steps: TranslationKey[] = ['onboarding.finish.step1', 'onboarding.finish.step2', 'onboarding.finish.step3', 'onboarding.finish.step4']
  return <div className="ob-stack">
    <ol className="ob-howto">
      {steps.map((key, i) => <li key={key}><span className="ob-howto__n" aria-hidden="true">{i + 1}</span>
        <span>{t(key, { record, focusUrl: SHORTCUTS.focusUrl() })}</span></li>)}
    </ol>
    <div className="ob-card">
      <span className="ob-field__label">{t('onboarding.finish.privacy')}</span>
      <CrashReportsSetting />
    </div>
    <p className="ob-note">{t('onboarding.finish.reopen')}</p>
  </div>
}
