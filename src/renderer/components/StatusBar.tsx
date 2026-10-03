import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AudioLines,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Download,
  Globe,
  Lock,
  Mic,
  MicOff,
  PanelBottom,
  PanelRight,
  RefreshCw,
  Settings,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import type { BrowserState, SttAvailability } from '@shared/types'
import { STT_PROVIDER_PRESETS, STT_REMOTE_PROVIDERS, providerLabel } from '@shared/aiProviders'
import { DEFAULT_LAYOUT, type Dock, type DragPanel, type FooterItemId } from '@shared/layout'
import { PanelGrip } from './PanelDock'
import type { UpdateCheckResult } from '@shared/appVersion'
import { Button, RecordDot, Spinner, ThemeToggle } from '../ui'
import type { SpeechLanguage, Transcription } from './SettingsPage'
import { StatusPopover as Popover } from './StatusPopover'
import { ResourceManager } from './ResourceManager'
import { UsageMeter } from './UsageMeter'
import { useT, type TFunction } from '../lib/i18n'

/**
 * 下部ステータスバー（24px）。
 * 常時見えるが主張しない帯。いま何で録って・何で文字起こしして・
 * 何で整理するのかを、見れば分かる場所に置く（EXT-1 / EXT-9 / REC-3）。
 *
 * 項目はクリックでその場の設定を開く（マイク・更新・ターミナルの置き場所・設定）。
 * Orca の下部ステータスバーと同じく「小さな項目＋上に開くポップオーバー」の形にする
 * （~/bench/orca/src/renderer/src/components/status-bar/StatusBarSurface.tsx）。
 */
function Item({
  icon: Icon,
  label,
  value,
  tone = 'ok'
}: {
  icon: LucideIcon
  label: string
  value: string
  /** ok … 使える / warn … 設定が足りない / off … 使わない設定 */
  tone?: 'ok' | 'warn' | 'off'
}) {
  return (
    <span className={`statusbar__item statusbar__item--${tone}`} title={`${label}: ${value}`}>
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      <span className="statusbar__value">{value}</span>
    </span>
  )
}

/** 値の文言から状態の色を決める。未設定は気づけるよう注意色にする */
function toneOf(value: string | undefined, t: TFunction): 'ok' | 'warn' | 'off' {
  if (!value || value === t('capture.summary.notSet') || value === t('capture.summary.localMissing')) return 'warn'
  if (value === t('capture.summary.noRecording')) return 'off'
  return 'ok'
}

/** ステータスバーに出すページ名。題名が無ければホストだけ */
function pageLabel(state: BrowserState): string {
  if (state.title) return state.title
  try {
    return new URL(state.url).host || state.url
  } catch {
    return state.url
  }
}

/**
 * 録る・書き起こす・整理するの構成（REC-3 / EXT-1 / EXT-9）。
 * 未設定の項目は「未設定」と出す。
 */
export interface CaptureStatus {
  /** 使用するマイク（REC-3） */
  microphone?: string
  /** 文字起こしの方式（EXT-1） */
  transcription?: string
  /** 指摘へ整理するAgent（EXT-9） */
  organizer?: string
}

/** フッターから変えられる録音の設定。App の state（＝設定ダイアログと同じ値）をそのまま受ける */
export interface FooterCapture {
  captureMic: boolean
  micDeviceId: string
  captureSystemAudio: boolean
  transcription: Transcription
  language: SpeechLanguage
}

type PopoverKind = 'mic' | 'update' | 'resources'

function PopSwitch({ label, hint, checked, disabled, onChange }: { label: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <label className="st-row st-row--switch" data-disabled={disabled || undefined}>
    <span className="st-row__label">{label}{hint}</span>
    <input type="checkbox" role="switch" className="st-switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  </label>
}

function PopSelect({ label, children }: { label: string; children: ReactNode }) {
  return <label className="st-row"><span className="st-row__label">{label}</span><span className="rv-select">{children}</span></label>
}

/**
 * 録画していない間のマイクの入力レベル。ポップオーバーを開いている間だけマイクを掴む。
 * 録画中は main から届く recording:level を使う（同じマイクを二重に開かない）。
 */
function useMicLevel(active: boolean, deviceId: string): { level: number; error: boolean } {
  const [level, setLevel] = useState(0)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!active) { setLevel(0); setError(false); return }
    let stopped = false
    let frame = 0
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    void navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
      stream = s
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(s).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const tick = () => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        setLevel(Math.sqrt(sum / buf.length))
        frame = requestAnimationFrame(tick)
      }
      tick()
    }).catch(() => { if (!stopped) setError(true) })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [active, deviceId])
  return { level, error }
}

function LevelMeter({ level, live }: { level: number; live: boolean }) {
  // 録画ツールバーの MicLevel と同じ倍率（話し声で半分ほど振れる）
  const t = useT()
  const value = live ? Math.min(1, level * 5) : 0
  return <div className="sb-meter" role="meter" aria-label={t('statusBar.inputLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
    <span className="sb-meter__bar" style={{ transform: `scaleX(${value})` }} />
  </div>
}

function MicPopover({ value, onChange, recording, micDevices, available, level, onOpenSettings }: {
  value: FooterCapture
  onChange: (patch: Partial<FooterCapture>) => void
  recording: boolean
  micDevices: Array<{ id: string; label: string }>
  available: SttAvailability
  level: number
  onOpenSettings: () => void
}) {
  const t = useT()
  const probe = useMicLevel(!recording && value.captureMic, value.micDeviceId)
  const live = value.captureMic && (recording || !probe.error)
  return <div className="sb-pop__body">
    <h3 className="sb-pop__title"><Mic size={13} aria-hidden="true" />{t('statusBar.micAndTranscription')}</h3>
    {recording && <p className="st-lock"><Lock size={12} aria-hidden="true" />{t('statusBar.lockedWhileRecording')}</p>}
    <PopSwitch label={t('statusBar.recordMyVoice')} checked={value.captureMic} disabled={recording} onChange={(captureMic) => onChange({ captureMic })} />
    <PopSelect label={t('statusBar.microphone')}>
      <select className="st-select" aria-label={t('statusBar.micToUse')} value={value.micDeviceId} disabled={recording || !value.captureMic} onChange={(e) => onChange({ micDeviceId: e.target.value })}>
        <option value="">{t('statusBar.systemDefault')}</option>
        {micDevices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
      </select>
    </PopSelect>
    <div className="st-row">
      <span className="st-row__label">{t('statusBar.level')}</span>
      <LevelMeter level={recording ? level : probe.level} live={live} />
    </div>
    {value.captureMic && probe.error && !recording && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('statusBar.micOpenFailed')}</p>}
    <PopSwitch label={t('statusBar.recordOtherVoice')} hint={<span className="st-beta">β</span>} checked={value.captureSystemAudio} disabled={recording} onChange={(captureSystemAudio) => onChange({ captureSystemAudio })} />
    <PopSelect label={t('statusBar.transcription')}>
      <select className="st-select" aria-label={t('statusBar.transcriptionMethod')} value={value.transcription} disabled={recording} onChange={(e) => onChange({ transcription: e.target.value as Transcription })}>
        <option value="local">{available.localReady ? t('statusBar.sttLocal') : t('statusBar.sttLocalMissing')}</option>
        {/* 使える提供元だけを出す（選んでいるものは未設定でも残す）。設定は「詳しい設定…」から */}
        {STT_REMOTE_PROVIDERS.filter((p) => available.stt[p] || p === value.transcription).map((p) =>
          <option key={p} value={p} disabled={!available.stt[p]}>{available.stt[p] ? providerLabel(STT_PROVIDER_PRESETS[p], t) : t('ai.stt.optionNotReady', { label: providerLabel(STT_PROVIDER_PRESETS[p], t) })}</option>)}
      </select>
    </PopSelect>
    <PopSelect label={t('statusBar.language')}>
      <select className="st-select" aria-label={t('statusBar.spokenLanguage')} value={value.language} disabled={recording} onChange={(e) => onChange({ language: e.target.value as SpeechLanguage })}>
        <option value="auto">{t('statusBar.langAuto')}</option><option value="ja">{t('statusBar.langJa')}</option><option value="en">{t('statusBar.langEn')}</option>
      </select>
    </PopSelect>
    <div className="sb-pop__foot">
      <Button variant="ghost" onClick={onOpenSettings}>{t('statusBar.moreSettings')}</Button>
    </div>
  </div>
}

function UpdatePopover({ version, packaged }: { version: string; packaged: boolean }) {
  const t = useT()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const check = () => {
    setChecking(true)
    void window.ade.invoke('app:checkUpdate')
      .then(setResult)
      .catch(() => setResult({ state: 'error', current: version, message: t('statusBar.checkFailed') }))
      .finally(() => setChecking(false))
  }
  return <div className="sb-pop__body" data-testid="statusbar-update">
    <h3 className="sb-pop__title"><RefreshCw size={13} aria-hidden="true" />{t('statusBar.update')}</h3>
    <div className="st-row"><span className="st-row__label">{t('statusBar.currentVersion')}</span><span className="sb-pop__mono">v{version}</span></div>
    {result?.state === 'latest' && <p className="st-note st-note--ok"><CircleCheck size={12} aria-hidden="true" />{t('statusBar.upToDate', { version: result.latest })}</p>}
    {result?.state === 'available' && <div className="st-note st-note--action">
      <span><Download size={12} aria-hidden="true" />{t('statusBar.updateAvailable', { version: result.latest })}</span>
      <Button onClick={() => void window.ade.invoke('app:openUpdate')}>{t('statusBar.open')}</Button>
    </div>}
    {result?.state === 'no-release' && <p className="st-note">{t('statusBar.noRelease')}</p>}
    {result?.state === 'no-source' && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('statusBar.noSource')}</p>}
    {result?.state === 'error' && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('statusBar.checkFailedWith', { message: result.message })}</p>}
    {!packaged && <p className="st-note">{t('statusBar.devBuild')}</p>}
    <div className="sb-pop__foot">
      <Button busy={checking} icon={<RefreshCw size={14} />} onClick={check} data-testid="statusbar-check-update">{t('statusBar.checkForUpdates')}</Button>
    </div>
  </div>
}

export function StatusBar({
  items = DEFAULT_LAYOUT.footer.items,
  onStartDrag,
  state,
  capture,
  recording,
  elapsed,
  settings,
  onCaptureChange,
  micDevices,
  available,
  level,
  terminalDock,
  onTerminalDockChange,
  onOpenSettings,
  onPopoverChange,
  onOpenTerminal,
  onOpenPage,
  onManageAccounts
}: {
  /** 出す項目（設定の「レイアウト」で選ぶ）。省略時はすべて */
  items?: Record<FooterItemId, boolean>
  /** 左端のつまみを掴んで、フッターを上か下へ運ぶ */
  onStartDrag?: (panel: DragPanel, e: React.PointerEvent) => void
  state: BrowserState
  capture: CaptureStatus
  recording: boolean
  elapsed: string
  settings: FooterCapture
  onCaptureChange: (patch: Partial<FooterCapture>) => void
  micDevices: Array<{ id: string; label: string }>
  available: SttAvailability
  /** 録画中のマイクのレベル（recording:level） */
  level: number
  terminalDock: Dock
  onTerminalDockChange: (dock: Dock) => void
  onOpenSettings: () => void
  /** ポップオーバーの開閉。開いている間は内蔵ブラウザのビューを隠してもらう */
  onPopoverChange: (open: boolean) => void
  /** Resource Manager の行から、そのターミナルへ移る */
  onOpenTerminal: (projectId: string | null, terminalId: string) => void
  /** Resource Manager の行から、内蔵ブラウザのページへ移る */
  onOpenPage: (projectId: string | null) => void
  /** 使用量表示のポップオーバーの「アカウントを管理…」 */
  onManageAccounts?: () => void
}) {
  const t = useT()
  const mic = settings.captureMic ? capture.microphone ?? t('capture.summary.notSet') : t('capture.summary.noRecording')
  const page = pageLabel(state)
  const [open, setOpen] = useState<PopoverKind | null>(null)
  const [version, setVersion] = useState({ version: '', packaged: true })
  const micRef = useRef<HTMLButtonElement | null>(null)
  const updateRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    void window.ade.invoke('app:version').then(setVersion).catch(() => undefined)
  }, [])

  /** 使用量表示のポップオーバー（UsageMeter が自分で開閉する）。これもビューを隠す対象に入れる */
  const [usageOpen, setUsageOpen] = useState(false)
  useEffect(() => { onPopoverChange(open !== null || usageOpen) }, [open, usageOpen, onPopoverChange])

  const close = useCallback(() => setOpen(null), [])
  const toggle = (kind: PopoverKind) => setOpen((cur) => (cur === kind ? null : kind))
  const openSettings = () => { setOpen(null); onOpenSettings() }

  return (
    <footer className="statusbar" data-testid="statusbar">
      {onStartDrag && <PanelGrip panel="footer" onStart={onStartDrag} />}
      {/* Agent の使用量とアカウント切り替え（Orca の左下と同じ位置） */}
      {items.usage && <>
        <UsageMeter onManageAccounts={onManageAccounts} onOpenChange={setUsageOpen} />
        <span className="statusbar__divider" aria-hidden="true" />
      </>}
      {items.recording && <>
        <span className={`statusbar__rec${recording ? ' is-recording' : ''}`}>
          <RecordDot active={recording} size={6} />
          <span className="statusbar__elapsed">{elapsed}</span>
        </span>
        <span className="statusbar__divider" aria-hidden="true" />
      </>}

      {items.mic && <span className="statusbar__group">
        <button
          type="button"
          className={`statusbar__btn statusbar__item--${settings.captureMic ? 'ok' : 'off'}`}
          aria-pressed={settings.captureMic}
          aria-label={settings.captureMic ? t('statusBar.micOff') : t('statusBar.micOn')}
          title={recording ? t('statusBar.lockedWhileRecording') : settings.captureMic ? t('statusBar.micStateOn') : t('statusBar.micStateOff')}
          disabled={recording}
          onClick={() => onCaptureChange({ captureMic: !settings.captureMic })}
          data-testid="statusbar-mic-toggle"
        >
          {settings.captureMic ? <Mic size={12} strokeWidth={2} aria-hidden="true" /> : <MicOff size={12} strokeWidth={2} aria-hidden="true" />}
        </button>
        <button
          ref={micRef}
          type="button"
          className={`statusbar__btn statusbar__item--${toneOf(mic, t)}`}
          aria-haspopup="dialog"
          aria-expanded={open === 'mic'}
          title={t('statusBar.micTitle', { value: mic })}
          onClick={() => toggle('mic')}
          data-testid="statusbar-mic"
        >
          <span className="statusbar__value">{mic}</span>
          <ChevronUp size={11} strokeWidth={2} aria-hidden="true" />
        </button>
      </span>}
      {items.transcription && <Item
        icon={AudioLines}
        label={t('statusBar.transcription')}
        value={capture.transcription ?? t('capture.summary.notSet')}
        tone={toneOf(capture.transcription, t)}
      />}
      {items.organizer && <Item
        icon={Sparkles}
        label={t('statusBar.organizer')}
        value={capture.organizer ?? t('capture.summary.notSet')}
        tone={toneOf(capture.organizer, t)}
      />}

      <span className="statusbar__spacer" />

      {items.resources && <><ResourceManager
        open={open === 'resources'}
        onToggle={() => toggle('resources')}
        onClose={close}
        onOpenTerminal={onOpenTerminal}
        onOpenPage={onOpenPage}
      />
      <span className="statusbar__divider" aria-hidden="true" /></>}

      {items.page && <><span
        className={`statusbar__item statusbar__item--url${page ? '' : ' is-empty'}`}
        title={state.url || undefined}
      >
        <Globe size={12} strokeWidth={2} aria-hidden="true" />
        <span className="statusbar__value">{page || t('statusBar.notConnected')}</span>
      </span>
      <span className="statusbar__divider" aria-hidden="true" /></>}
      {/* ターミナルを右↔下へ素早く切り替える。左・上を含む細かい配置は設定の「レイアウト」で選ぶ */}
      {items.layout && <button
        type="button"
        className="statusbar__btn statusbar__btn--icon"
        aria-label={terminalDock === 'right' ? t('statusBar.dockBottom') : t('statusBar.dockRight')}
        title={terminalDock === 'right' ? t('statusBar.dockRightTitle') : t('statusBar.dockBottomTitle')}
        onClick={() => onTerminalDockChange(terminalDock === 'right' ? 'bottom' : 'right')}
        data-testid="statusbar-dock"
        data-dock={terminalDock}
      >
        {terminalDock === 'right' ? <PanelRight size={13} strokeWidth={2} aria-hidden="true" /> : <PanelBottom size={13} strokeWidth={2} aria-hidden="true" />}
      </button>}
      {items.version && <button
        ref={updateRef}
        type="button"
        className="statusbar__btn statusbar__version"
        aria-haspopup="dialog"
        aria-expanded={open === 'update'}
        title={t('statusBar.versionAndUpdates')}
        onClick={() => toggle('update')}
        data-testid="statusbar-version"
      >
        {checkingLabel(version.version)}
      </button>}
      {items.theme && <ThemeToggle />}
      {items.settings && <button
        type="button"
        className="statusbar__btn statusbar__btn--icon"
        aria-label={t('statusBar.openSettings')}
        title={t('common.settings')}
        onClick={openSettings}
        data-testid="statusbar-settings"
      >
        <Settings size={13} strokeWidth={2} aria-hidden="true" />
      </button>}

      {open === 'mic' && <Popover anchor={micRef.current} label={t('statusBar.micAndTranscription')} onClose={close}>
        <MicPopover value={settings} onChange={onCaptureChange} recording={recording} micDevices={micDevices}
          available={available} level={level} onOpenSettings={openSettings} />
      </Popover>}
      {open === 'update' && <Popover anchor={updateRef.current} label={t('statusBar.update')} onClose={close}>
        <UpdatePopover version={version.version} packaged={version.packaged} />
      </Popover>}
    </footer>
  )
}

/** バージョンを取れるまでは小さなスピナーを出す */
function checkingLabel(version: string): ReactNode {
  return version ? `v${version}` : <Spinner size={10} />
}
