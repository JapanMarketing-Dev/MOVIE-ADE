import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, FolderOpen, Mic, MonitorUp, RefreshCw } from 'lucide-react'
import type { AgentOption, AgentPreferences, BuiltinAgent, Project, ProjectsState, SttAvailability, SttProvider } from '@shared/types'
import { AGENT_CATALOG, isBuiltinAgent } from '@shared/agentCatalog'
import { type TranslationKey } from '@shared/i18n'
import type { MediaAccessStatus, PermissionKind, PermissionsState } from '@shared/onboarding'
import { Button, Field, LocaleSelect, RecordButton, ThemeSegmented, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { SHORTCUTS, formatShortcut } from '../lib/shortcut'
import { setAgentEnabled, toggleStartupAgent } from '../lib/agentPrefs'
import { listAgents } from '../lib/agentListing'
import { errorMessage } from '../lib/errors'
import { ProjectTargetsEditor } from '../components/ProjectTargetsEditor'
import { AgentIcon } from '../components/AgentIcon'
import { TranscriptionSection, type SpeechLanguageValue } from '../components/TranscriptionSection'
import { CrashReportsSetting } from '../components/CrashReportsSetting'
import { agentInstallCommand } from './agentInstall'
import { FINISH_STEP_KEYS, recommendedAgent } from './onboardingFlowState'
import { AgentInstallTerminal } from './AgentInstallTerminal'

/**
 * セットアップの各手順の中身。設定の保存は既存の経路（lib/theme・lib/i18n・settings:agents・project:*・
 * 文字起こしの節・settings:crashReports）をそのまま使い、ここで新しい設定は持たない。
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/ThemeStep.tsx・AgentStep.tsx の
 *           「選ぶとすぐ反映」「検出済みを先に並べ、無いものには入れ方を出す」使い心地（MIT）。
 */

// ───────────────────────── 見た目（配色・言語） ─────────────────────────

export function AppearanceStep() {
  const t = useT()
  return <div className="ob-stack">
    <div className="ob-field">
      <span className="ob-field__label">{t('onboarding.appearance.theme')}</span>
      <ThemeSegmented />
    </div>
    <div className="ob-field">
      <span className="ob-field__label">{t('onboarding.appearance.language')}</span>
      <LocaleSelect ariaLabel={t('onboarding.appearance.language')} testId="onboarding-locale-select" />
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

export function AgentsStep({ agents, onAgentsChange, onDetected, warn = false }: {
  agents: AgentPreferences
  onAgentsChange: (next: AgentPreferences) => void
  /** 探し終えた一覧（「次へ」で、どれか1つを選んだかを見るため） */
  onDetected?: (options: AgentOption[]) => void
  /** 1つも選ばずに進もうとした */
  warn?: boolean
}) {
  const t = useT()
  const [options, setOptions] = useState<AgentOption[] | null>(null)
  const detect = useCallback((refresh: boolean) => {
    setOptions(null)
    void window.ade.invoke('agents:list', refresh).then(setOptions).catch(() => setOptions([]))
  }, [])
  // PATH を読み直して探す（Orca も手順を開いたときに検出し直す）
  useEffect(() => detect(true), [detect])
  /** インストールが終わったあとの検出し直し。一覧は消さずに差し替える（ほかのカードのインストールを止めない） */
  const refreshAfterInstall = useCallback((id: BuiltinAgent) => window.ade.invoke('agents:list', true)
    .then((next) => { setOptions(next); return next.some((o) => o.id === id && o.installed) }), [])

  const builtins = (options ?? []).filter((o): o is AgentOption & { id: BuiltinAgent } => !o.custom && isBuiltinAgent(o.id))
  // 40種以上あるので、見つかったもの → 主要なもの を先に見せ、残りは「すべて表示」にたたむ。検索欄で全部から探せる
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const { visible: sorted, hiddenCount } = listAgents(builtins, { query, showAll, selected: agents.startupAgents })
  const toggle = (id: BuiltinAgent, on: boolean) => {
    const enabled = on ? setAgentEnabled(agents, id, true) : agents
    onAgentsChange(toggleStartupAgent(enabled, id, on))
  }
  const missingSelected = agents.startupAgents.some((id) => builtins.some((o) => o.id === id && !o.installed))
  const noneInstalled = options !== null && !builtins.some((o) => o.installed)
  // 探し終えたら知らせ、何も選んでいなければおすすめ（インストール済みの Claude Code → Codex → …）を1つ選んでおく（開いたときに1度だけ）
  const autoPickedRef = useRef(false)
  useEffect(() => {
    if (!options) return
    onDetected?.(options)
    if (autoPickedRef.current) return
    autoPickedRef.current = true
    const pick = recommendedAgent(options, agents.startupAgents)
    if (pick) onAgentsChange(toggleStartupAgent(setAgentEnabled(agents, pick, true), pick, true))
  }, [options])

  return <div className="ob-stack">
    {options === null
      ? <p className="ob-note" role="status">{t('onboarding.agents.detecting')}</p>
      : <>
      <Field type="search" className="ob-agents__search" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder={t('agents.searchPlaceholder')} aria-label={t('agents.searchPlaceholder')} data-testid="onboarding-agent-search" />
      <div className="ob-agents" role="group" aria-label={t('onboarding.agents.title')}>
        {sorted.map((option) => {
          const order = agents.startupAgents.indexOf(option.id)
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
                {/* 押したときだけ、カードの中のターミナルでインストールする（コピーは小さな補助のボタン） */}
                <AgentInstallTerminal agentId={option.id} label={option.label} command={agentInstallCommand(option.id)}
                  guideUrl={AGENT_CATALOG[option.id].homepageUrl} onRefresh={() => refreshAfterInstall(option.id)} />
              </div>}
          </div>
        })}
      </div>
      {query.trim() && sorted.length === 0 && <p className="ob-note" role="status">{t('agents.noMatch')}</p>}
      {!query.trim() && (hiddenCount > 0 || showAll) && <div>
        <Button variant="ghost" onClick={() => setShowAll((v) => !v)} data-testid="onboarding-agent-show-all">
          {showAll ? t('agents.showLess') : t('agents.showAll', { count: hiddenCount })}</Button>
      </div>}
      </>}
    {warn && agents.startupAgents.length === 0 && <p className="ob-note ob-note--warn" role="alert" data-testid="onboarding-agents-pick-one">
      <CircleAlert size={12} aria-hidden="true" />{t('onboarding.agents.pickOne')}</p>}
    {noneInstalled && <p className="ob-note ob-note--warn" data-testid="onboarding-agents-none-installed">
      <CircleAlert size={12} aria-hidden="true" />{t('onboarding.agents.noneInstalled')}</p>}
    <p className="ob-note">{t('onboarding.agents.customHint')}</p>
    <div className="ob-row">
      <p className={`ob-note${missingSelected ? ' ob-note--warn' : ''}`}>
        {t(agents.startupAgents.length === 0 ? 'onboarding.agents.noneSelected' : missingSelected ? 'onboarding.agents.missingSelected' : 'onboarding.agents.more')}
      </p>
      <Button variant="ghost" icon={<RefreshCw size={13} />} disabled={options === null} onClick={() => detect(true)}>{t('onboarding.agents.recheck')}</Button>
    </div>
  </div>
}

// ───────────────────────── プロジェクト ─────────────────────────

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

/**
 * 選んだプロジェクトの種類（web / mobile / desktop / other）と確認先。確認先は名前が自由で件数の上限なし
 * （local / dev / prd は web の名前の候補）。編集と保存は ProjectTargetsEditor が行う。
 */
function ProjectUrls({ project }: { project: Project }) {
  return <div className="ob-card">
    <div className="ob-card__head">
      <FolderOpen size={14} aria-hidden="true" />
      <span className="ob-card__title">{project.name}</span>
      <code className="ob-card__path" title={project.folderPath}>{project.folderPath}</code>
    </div>
    <ProjectTargetsEditor project={project} />
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

export function VoiceStep({ voice }: { voice: OnboardingVoice }) {
  const t = useT()
  return <div className="ob-stack">
    <p className="ob-note">{t('onboarding.voice.byok')}</p>
    {/* 選ぶ場所は Engine の選択1つ（端末内の whisper・提供元・Custom）。言語は自動のまま、詳細は設定画面で */}
    <div className="ob-card">
      <TranscriptionSection headless onboarding transcription={voice.transcription} onTranscriptionChange={voice.onTranscriptionChange}
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
  // 会議でも使えること（録画の対象）と、判定モデルで Agent が確かめることを流れの中に入れる（onboardingFlowState.ts）
  const steps: readonly TranslationKey[] = FINISH_STEP_KEYS
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
