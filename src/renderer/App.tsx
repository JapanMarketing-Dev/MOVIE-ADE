import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AGENT_PREFERENCES,
  DEFAULT_SPLIT_RATIO,
  DEFAULT_URL,
  type AgentPreferences,
  type AppMode,
  type BrowserState,
  type ProjectsState,
  type WorkspaceState
} from '@shared/types'
import { BrowserSlot, type SlotEmptyReason } from './components/BrowserSlot'
import { BrowserToolbar } from './components/BrowserToolbar'
import { CenterTabs, isFileTab, type CenterTab } from './components/CenterTabs'
import { layoutSignature, mainSplitGrid, withPanel, workspaceGrid, type Dock } from '@shared/layout'
import { initLayout, setLayout, useLayout } from './lib/layout'
import { DockOverlay, PanelGrip, usePanelDrag } from './components/PanelDock'
import { FileExplorer } from './components/FileExplorer'
import { QuickOpen } from './components/QuickOpen'
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog'
import { useOpenFiles } from './editor/useOpenFiles'
import { FeedbackToolbar, type AnnotationTool } from './components/FeedbackToolbar'
import { ReviewTargetsPanel } from './components/ReviewTargetsPanel'
import { readLocal, writeLocal } from './lib/localPref'
import { CaptureTargetPicker } from './components/CaptureTargetPicker'
import { FindingsList } from './components/FindingsList'
import { Sidebar, toReviewSession } from './components/Sidebar'
import { DEMO_SESSION_IDS, EMPTY_CAPTURE, demoCapture, demoFindings, demoSessions } from './demoData'
import { Splitter } from './components/Splitter'
import { StatusBar, type FooterCapture } from './components/StatusBar'
import { TerminalPane } from './components/TerminalPane'
import { TitleBar } from './components/TitleBar'
import { Gallery } from './gallery/Gallery'
import { useViewBounds } from './hooks/useViewBounds'
import { useProjectSession } from './hooks/useProjectSession'
import { installTestHooks } from './testHooks'
import { ErrorBoundary, ToastProvider, useToast } from './ui'
import { sanitizeAgentPreferences } from '@shared/agentCatalog'
import { CrashReportNotice } from './components/CrashReportNotice'
import type { CaptureTarget, RecordingStatus, SttAvailability, SttProvider } from '@shared/types'
import { AI_VENDORS, LLM_API_PROVIDERS, STT_PROVIDER_PRESETS, STT_REMOTE_PROVIDERS, providerLabel } from '@shared/aiProviders'
import type { ReviewData, ReviewSummary } from '@shared/review'
import { ReviewFindings } from './components/ReviewFindings'
import { errorMessage } from './lib/errors'
import { useT } from './lib/i18n'
import { SettingsPage, type CaptureSettings } from './components/SettingsPage'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './lib/settingsSections'
import { shouldShowOnboarding, type OnboardingPatch, type OnboardingState } from '@shared/onboarding'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { reopenPatch } from './onboarding/onboardingFlowState'
import { onShowOnboardingRequested } from './onboarding/showOnboardingEvent'
import { reportHandled } from '@shared/report'

/** Monaco は重いので、ファイルを初めて開いたときに読む（起動時間 NF-5） */
const FileEditor = lazy(() => import('./editor/FileEditor'))

const INITIAL_BROWSER_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  viewport: 'desktop'
}

/** 非表示のモードの置き場所は測らない（測ると0サイズを送ってビューが消える） */
function noopRef(): void {}

/** 部品見本は URL の #gallery で開く（E2Eからも開ける）*/
function galleryRequested(): boolean {
  return window.location.hash === '#gallery'
}

export function App() {
  // 初回のセットアップを閉じるまで、クラッシュレポートの案内は出さない（セットアップの最後で同じことを選べる）
  const [onboardingSettled, setOnboardingSettled] = useState(false)
  const settle = useCallback(() => setOnboardingSettled(true), [])
  return (
    <ToastProvider>
      <Workspace onOnboardingSettled={settle} />
      {onboardingSettled && <CrashReportNotice />}
    </ToastProvider>
  )
}

function Workspace({ onOnboardingSettled }: { onOnboardingSettled: () => void }) {
  const [mode, setMode] = useState<AppMode>('editor')
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    folderPath: null,
    folderName: null
  })
  const [projects, setProjects] = useState<ProjectsState>({ projects: [], activeProjectId: null })
  const [agents, setAgents] = useState<AgentPreferences>(DEFAULT_AGENT_PREFERENCES)
  /** Agentへ渡す指示のテンプレート。空なら既定文 */
  const [agentPrompt, setAgentPrompt] = useState('')
  /** プロジェクト一覧・URL登録ダイアログ。開いている間はビューを隠す（ビューがDOMの上に重なるため） */
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [urlDialogOpen, setUrlDialogOpen] = useState(false)
  /** 設定とワークスペースを読み終えたか。終わるまでターミナルは作らない（projectId=null 用の余分なシェルを残さない） */
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [browserState, setBrowserState] = useState<BrowserState>(INITIAL_BROWSER_STATE)
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO)
  /**
   * パネルの置き場所と表示（設定の「レイアウト」・メニューの ⌘B / ⌘J と同じ値。lib/layout.ts）。
   * splitRatio は中央のタブ群の大きさで、ターミナルが左右なら幅、上下なら高さに使う
   */
  const layout = useLayout()
  const terminalDock = layout.panels.terminal.dock
  /** パネルのつまみをドラッグ中（画面の端へ運んで置き場所を変える）。その間はビューを隠す */
  const panelDrag = usePanelDrag()
  /** フッターのポップオーバー。開いている間はビューを隠す（ビューがDOMの上に重なるため） */
  const [footerPopoverOpen, setFooterPopoverOpen] = useState(false)
  /** 境界をドラッグ中。ビューの上でポインターが途切れないよう、その間はビューを隠す */
  const [splitDragging, setSplitDragging] = useState(false)
  const [gallery, setGallery] = useState(galleryRequested)
  /**
   * 初回起動のセットアップ（src/renderer/onboarding/）。undefined は設定の読み込み前。
   * 開いている間は内蔵ブラウザのビューを隠し、最初に閉じるまでターミナル（＝Agent の自動起動）を作らない
   */
  const [onboarding, setOnboarding] = useState<OnboardingState | null | undefined>(undefined)
  const onboardingOpen = onboarding !== undefined && !gallery && shouldShowOnboarding(onboarding ?? undefined)
  const [terminalsAllowed, setTerminalsAllowed] = useState(false)
  useEffect(() => {
    if (onboarding === undefined || onboardingOpen || terminalsAllowed) return
    setTerminalsAllowed(true)
    onOnboardingSettled()
  }, [onboarding, onboardingOpen, terminalsAllowed, onOnboardingSettled])
  const persistOnboarding = useCallback(async (patch: OnboardingPatch) => {
    setOnboarding(await window.ade.invoke('settings:onboarding', patch))
  }, [])
  const sidebarOpen = layout.panels.projects.visible
  const setSidebarOpen = (next: (open: boolean) => boolean) => setLayout((prev) => withPanel(prev, 'projects', { visible: next(prev.panels.projects.visible) }))
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null)
  const [centerTab, setCenterTab] = useState<CenterTab>('browser')
  /** 中央のタブの並び（ドラッグで並べ替えた順）。開いているファイルは閉じれば消えるので保存しない */
  const [centerOrder, setCenterOrder] = useState<CenterTab[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  /*
   * 録画の中身は後続の実装（REC-1〜）。ここでは状態と見た目だけを持つ。
   * 押すとフィードバックモードへ移って録画を始める（MODE-3）という流れだけ再現する。
   */
  const [recordStatus, setRecordStatus] = useState<RecordingStatus>({ state: 'idle', elapsedMs: 0, videoBytes: 0, frameCount: 0, eventCount: 0 })
  const recording = recordStatus.state !== 'idle'
  const [recordBusy, setRecordBusy] = useState(false)
  const recordLock = useRef(false)
  const [review, setReview] = useState<ReviewData | null>(null)
  const [history, setHistory] = useState<ReviewSummary[]>([])
  /** 設定のページ（中央のタブ）を開いているか。focus は外から節を指定して開いたときの行き先 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsFocus, setSettingsFocus] = useState<{ section: SettingsSectionId; nonce: number } | null>(null)
  const [transcription, setTranscription] = useState<SttProvider>('local')
  const [micDevices, setMicDevices] = useState<Array<{ id: string; label: string }>>([])
  const [micDeviceId, setMicDeviceId] = useState('')
  const [keepDays, setKeepDays] = useState(7)
  const [stayFeedbackOnStop, setStayFeedbackOnStop] = useState(false)
  const [language, setLanguage] = useState<'ja' | 'en' | 'auto'>('auto')
  const [captureSystemAudio, setCaptureSystemAudio] = useState(false)
  const [level, setLevel] = useState(0)
  /** フィードバック画面の帯に出す警告（トーストはビューに隠れるため） */
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000)
  }, [])
  const [captureMic, setCaptureMic] = useState(true)
  /** 文字起こし・整理の提供元ごとの準備状況（キーと接続先は設定の節がその場で保存する） */
  const [available, setAvailable] = useState<SttAvailability>({ localReady: false, keyStorage: 'session',
    keys: Object.fromEntries(AI_VENDORS.map((v) => [v, null])) as SttAvailability['keys'],
    stt: Object.fromEntries(STT_REMOTE_PROVIDERS.map((p) => [p, false])) as SttAvailability['stt'],
    llm: Object.fromEntries(LLM_API_PROVIDERS.map((p) => [p, false])) as SttAvailability['llm'] })
  const toast = useToast()
  const t = useT()
  /** ファイルエディタ（中央のファイルタブ・右のファイルツリー・⌘P） */
  const explorerOpen = layout.panels.files.visible
  const setExplorerOpen = (next: (open: boolean) => boolean) => setLayout((prev) => withPanel(prev, 'files', { visible: next(prev.panels.files.visible) }))
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  /** ⌘P の画面を、フィードバックの右パネルの「ファイルを足す」から開いたか */
  const [quickOpenForTarget, setQuickOpenForTarget] = useState(false)
  /** フィードバックモードの右パネル（レビュー対象）。開閉と幅はこの端末に覚える */
  const [targetsOpen, setTargetsOpenState] = useState(() => readLocal('ade.feedback.targetsOpen') !== 'false')
  const [targetsRatio, setTargetsRatio] = useState(() => Number(readLocal('ade.feedback.targetsRatio')) || 0.78)
  const [addedTargetFile, setAddedTargetFile] = useState<{ path: string; at: number } | null>(null)
  const setTargetsOpen = (next: (open: boolean) => boolean) => setTargetsOpenState((prev) => {
    const value = next(prev)
    writeLocal('ade.feedback.targetsOpen', String(value))
    return value
  })
  const fileError = useCallback((message: string) => toast({ tone: 'danger', message }), [toast])
  const files = useOpenFiles({ root: workspace.folderPath, activeTab: centerTab, setActiveTab: setCenterTab, onError: fileError })
  // プロジェクトごとに、中央のタブ・開いていたファイル・表示中のレビューを覚えて戻す（URL は main が戻す）
  useProjectSession({
    projectId: workspace.projectId ?? null,
    root: workspace.folderPath,
    ready: projectsLoaded,
    centerTab,
    setCenterTab: (tab) => setCenterTab(tab as CenterTab),
    openPaths: files.files.map((file) => file.path),
    openFile: files.open,
    reviewId: sessionId,
    onRestoreReview: (id) => {
      setSessionId(id)
      setReview(null)
      // 消えたレビューは黙って空に戻す
      if (id) void window.ade.invoke('review:load', id).then(setReview).catch(() => setSessionId(null))
    }
  })
  /** 録画中に選んでいる書き込みの道具（PEN-1 / TXT-1）。中身は後続 */
  const [tool, setTool] = useState<AnnotationTool>('none')
  /** 録画の対象（内蔵ブラウザ／画面全体／別のウインドウ）。選んですぐ録画を始めるため ref にも持つ */
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget>({ kind: 'browser' })
  const captureTargetRef = useRef<CaptureTarget>({ kind: 'browser' })
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const terminalCommand = useRef<{ add: () => void; close: () => void } | null>(null)

  /*
   * 空状態（NF-13）。フォルダ未選択、またはURL未入力のときはDOMで案内を出す。
   * 内蔵ブラウザのビューはDOMの上に必ず重なるので、出している間はビューを隠す。
   */
  const emptyReason: SlotEmptyReason | null =
    workspace.folderPath === null
      ? 'no-folder'
      : browserState.url === '' || browserState.url === DEFAULT_URL
        ? 'no-url'
        : browserState.loadError
          ? 'load-failed'
          : null

  /** ビューに場所を譲ってよい条件。ひとつでも欠けたら 0 サイズにして隠す */
  const viewVisible =
    !gallery && !onboardingOpen && !targetPickerOpen && !footerPopoverOpen && !splitDragging && !panelDrag.drag && !projectMenuOpen && !urlDialogOpen && !quickOpenOpen && !files.pendingClose && emptyReason === null && (mode === 'feedback' || centerTab === 'browser')

  const layoutKey = [
    mode,
    splitRatio.toFixed(4),
    browserState.viewport,
    emptyReason ?? '-',
    centerTab,
    // パネルの置き場所・表示が変わると、内蔵ブラウザの置き場所も動く
    layoutSignature(layout),
    targetsOpen ? `t${targetsRatio.toFixed(4)}` : '-'
  ].join(':')
  const slotRef = useViewBounds(layoutKey, viewVisible)

  /** 連打（⌘⇧M）で古い値から切り替えないよう、最新のモードを同期して持つ */
  const modeRef = useRef<AppMode>('editor')
  const changeMode = useCallback((next: AppMode) => {
    modeRef.current = next
    setMode(next)
    void window.ade.invoke('mode:set', next)
  }, [])

  /** 録音の設定を変える。設定ダイアログとフッターで同じ state を使う（二重管理しない） */
  const patchCapture = (patch: Partial<CaptureSettings>) => {
    if (patch.captureMic !== undefined) setCaptureMic(patch.captureMic)
    if (patch.micDeviceId !== undefined) setMicDeviceId(patch.micDeviceId)
    if (patch.captureSystemAudio !== undefined) setCaptureSystemAudio(patch.captureSystemAudio)
    if (patch.language !== undefined) setLanguage(patch.language)
    if (patch.transcription !== undefined) setTranscription(patch.transcription)
    if (patch.keepDays !== undefined) setKeepDays(patch.keepDays)
    if (patch.stayFeedbackOnStop !== undefined) setStayFeedbackOnStop(patch.stayFeedbackOnStop)
  }

  /** フッターからの変更は閉じる操作が無いので、その場で保存する */
  const changeCaptureFromFooter = (patch: Partial<FooterCapture>) => {
    patchCapture(patch)
    void window.ade.invoke('settings:capture', { captureMic, captureSystemAudio, transcription, language, micDeviceId, keepDays, stayFeedbackOnStop, ...patch })
  }

  /** 設定のページでの変更も、その場で保存する。接続先が揃ったかでフッターの選択肢が変わるので読み直す */
  const changeCaptureFromSettings = (patch: Partial<CaptureSettings>) => {
    patchCapture(patch)
    void window.ade.invoke('settings:capture', { captureMic, captureSystemAudio, transcription, language, micDeviceId, keepDays, stayFeedbackOnStop, ...patch })
      // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      .then(() => window.ade.invoke('capture:availability')).then(setAvailable).catch(() => undefined)
  }
  /** 空のコマンドは main 側で既定へ戻して保存する。入力中の表示はそのまま（読み直すと打っている文字が消える） */
  const changeAgents = (next: AgentPreferences) => {
    setAgents(next)
    void window.ade.invoke('settings:agents', next)
  }
  const changeAgentPrompt = (next: string) => {
    setAgentPrompt(next)
    void window.ade.invoke('settings:agentPrompt', next.trim())
  }

  /** 設定のページを開く。section を渡すとその節へ移る。フィードバックモードではエディタへ戻ってから開く */
  const openSettings = useCallback((section?: SettingsSectionId) => {
    if (modeRef.current === 'feedback') changeMode('editor')
    setSettingsOpen(true)
    setCenterTab('settings')
    if (section) setSettingsFocus((prev) => ({ section, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [changeMode])
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setCenterTab((tab) => (tab === 'settings' ? 'browser' : tab))
  }, [])
  // App の外の部品（初回の告知など）からも開けるように、window のイベントでも受ける
  //   window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: 'general' } }))
  useEffect(() => {
    const onOpen = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string } | undefined>).detail?.section
      openSettings(SETTINGS_SECTIONS.includes(section as SettingsSectionId) ? (section as SettingsSectionId) : undefined)
    }
    window.addEventListener('ade:open-settings', onOpen)
    return () => window.removeEventListener('ade:open-settings', onOpen)
  }, [openSettings])

  const openFolder = useCallback(() => {
    void window.ade.invoke('workspace:open').then(setWorkspace).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }, [toast])

  const navigate = useCallback((url: string) => {
    void window.ade.invoke('browser:navigate', url)
  }, [])

  /** MODE-3 エディタで「録画」を押すとフィードバックモードへ移って始まる */
  const run = useCallback(async (fn: () => Promise<void>) => {
    try { await fn() } catch (err) {
      // IPC の失敗は main が送り済み（reportHandled が見分けて送らない）。renderer の処理の失敗だけが届く
      reportHandled(err, { area: 'ui', op: 'run action' })
      toast({ tone: 'danger', message: t('common.actionFailed'), detail: errorMessage(err) })
      if (modeRef.current === 'feedback') showNotice(errorMessage(err))
    }
  }, [toast, showNotice])

  const refreshHistory = useCallback(async () => { setHistory(await window.ade.invoke('review:list')) }, [])
  const toggleRecording = useCallback(() => {
    if (recordLock.current) return
    recordLock.current = true
    setRecordBusy(true)
    void run(async () => {
      if (recording) {
        // 保存に失敗しても、途中の記録は一覧に出す
        try {
          setRecordStatus(await window.ade.invoke('recording:stop'))
        } catch (err) {
          // フィードバック画面はビューが全面を覆い、知らせが見えない。エディタへ戻してから伝える
          changeMode('editor')
          // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
        await refreshHistory().catch(() => undefined)
          throw err
        }
        setTool('none')
        if (!stayFeedbackOnStop) changeMode('editor')
        setCenterTab('findings')
        await refreshHistory()
      } else {
        // 画面全体・別のウインドウを録るなら、内蔵ブラウザにページが無くてもよい（保存先のフォルダは要る）
        if (emptyReason && (emptyReason === 'no-folder' || captureTargetRef.current.kind === 'browser')) { toast({ tone: 'warning', message: emptyReason === 'load-failed' ? t('app.recordNoPage') : t('app.recordNoFolder') }); return }
        setCenterTab('browser')
        // 録画は書き込みなしで始まる。前回の停止が失敗して道具の表示が残っていても揃える
        setTool('none')
        changeMode('feedback')
        try {
          setRecordStatus(await window.ade.invoke('recording:start', { captureSystemAudio, captureMic, transcription, language, micDeviceId, captureTarget: captureTargetRef.current }))
        } catch (err) { changeMode('editor'); throw err }
      }
    }).finally(() => { recordLock.current = false; setRecordBusy(false) })
  }, [recording, emptyReason, changeMode, run, refreshHistory, toast, captureMic, transcription, captureSystemAudio, language, micDeviceId, stayFeedbackOnStop])

  /** 録画の対象を選んで、次回のために覚える */
  const chooseTarget = (target: CaptureTarget) => {
    captureTargetRef.current = target
    setCaptureTarget(target)
    void window.ade.invoke('capture:setTarget', target).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  const selectTool = (next: AnnotationTool) => void run(async () => {
    await window.ade.invoke('annotation:setMode', next === 'none' ? 'off' : next)
    setTool(next)
  })

  useEffect(() => {
    const offs = [
      window.ade.on('recording:level', (data) => { if (data.source === 'mic') setLevel(data.rms) }),
      window.ade.on('recording:status', setRecordStatus),
      window.ade.on('recording:warning', (message) => { toast({ tone: 'warning', message, duration: 0 }); showNotice(message) }),
      window.ade.on('review:ready', (data) => {
        setReview(data); setSessionId(data.id); setCenterTab('findings'); setTool('none')
        if (!stayFeedbackOnStop) changeMode('editor')
        void refreshHistory()
      })
    ]
    void run(async () => { setAvailable(await window.ade.invoke('capture:availability')); setMicDevices(await window.ade.invoke('capture:devices')); await refreshHistory() })
    return () => offs.forEach((off) => off())
  }, [workspace.folderPath, run, refreshHistory, toast, stayFeedbackOnStop, changeMode, showNotice])

  /*
   * 起動経路（NF-5）。設定・ワークスペース・ブラウザ状態を1度にまとめて取得し、
   * 最初の描画が終わった時点を「操作可能」として記録する。
   */
  useEffect(() => {
    let cancelled = false
    initLayout()
    void Promise.all([
      window.ade.invoke('app:settings'),
      window.ade.invoke('workspace:current'),
      window.ade.invoke('browser:state')
    ]).then(([settings, ws, state]) => {
      if (cancelled) return
      setSplitRatio(settings.splitRatio)
      setProjects({ projects: settings.projects, activeProjectId: settings.activeProjectId })
      // 古い形の設定（main が古いまま動いているときなど）でも描画が落ちないよう、ここでも整える
      setAgents(sanitizeAgentPreferences(settings.agents))
      setAgentPrompt(settings.agentPrompt ?? '')
      setOnboarding(settings.onboarding ?? null)
      if (settings.capture) {
        setCaptureMic(settings.capture.captureMic); setCaptureSystemAudio(settings.capture.captureSystemAudio)
        setTranscription(settings.capture.transcription); setLanguage(settings.capture.language); setMicDeviceId(settings.capture.micDeviceId ?? '')
        setKeepDays(settings.capture.keepDays); setStayFeedbackOnStop(settings.capture.stayFeedbackOnStop)
        if (settings.capture.captureTarget) { captureTargetRef.current = settings.capture.captureTarget; setCaptureTarget(settings.capture.captureTarget) }
      }
      setWorkspace(ws)
      setProjectsLoaded(true)
      setBrowserState(state)
      requestAnimationFrame(() => {
        void window.ade.invoke('app:ready').then((timing) => {
          console.log(`[startup] 操作可能まで ${timing.totalMs}ms`, timing.marks)
        })
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const offBrowser = window.ade.on('browser:stateChanged', setBrowserState)
    const offWorkspace = window.ade.on('workspace:changed', setWorkspace)
    const offProjects = window.ade.on('projects:changed', setProjects)
    const offMode = window.ade.on('mode:changed', (next) => { modeRef.current = next; setMode(next) })
    return () => {
      offBrowser()
      offWorkspace()
      offProjects()
      offMode()
    }
  }, [])

  /** ヘルプ → セットアップをもう一度・設定の「セットアップをもう一度」。録画中は全面を覆わない */
  const reopenOnboarding = useCallback(() => {
    if (recording) { toast({ tone: 'warning', message: t('errors.stopRecordingBeforeChange') }); return }
    if (modeRef.current === 'feedback') changeMode('editor')
    void persistOnboarding(reopenPatch()).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }, [recording, toast, t, changeMode, persistOnboarding])
  useEffect(() => onShowOnboardingRequested(reopenOnboarding), [reopenOnboarding])

  // メニュー（＝キーボードショートカット）からの指示
  useEffect(() => {
    return window.ade.on('menu:command', (command) => {
      switch (command) {
        case 'toggleRecording':
          toggleRecording()
          break
        case 'toggleMode':
          changeMode(modeRef.current === 'editor' ? 'feedback' : 'editor')
          break
        case 'toggleViewport':
          void window.ade.invoke(
            'browser:setViewport',
            browserState.viewport === 'desktop' ? 'mobile' : 'desktop'
          )
          break
        case 'focusUrl':
          setCenterTab('browser')
          urlInputRef.current?.focus()
          urlInputRef.current?.select()
          break
        case 'reloadPage':
          void window.ade.invoke('browser:reload')
          break
        case 'newTerminal':
          terminalCommand.current?.add()
          break
        case 'closeTerminal':
          terminalCommand.current?.close()
          break
        case 'toggleSidebar':
          setSidebarOpen((open) => !open)
          break
        case 'quickOpen':
          // フィードバック（録画）中はビューを隠さない
          if (workspace.folderPath && modeRef.current === 'editor') setQuickOpenOpen(true)
          break
        case 'saveFile':
          if (files.activeFile) void files.save(files.activeFile.id)
          break
        case 'toggleExplorer':
          setExplorerOpen((open) => !open)
          break
        case 'toggleTargets':
          setTargetsOpen((open) => !open)
          break
        case 'toggleTerminalPanel':
          setLayout((prev) => withPanel(prev, 'terminal', { visible: !prev.panels.terminal.visible }))
          break
        case 'toggleFooter':
          setLayout((prev) => ({ ...prev, footer: { ...prev.footer, visible: !prev.footer.visible } }))
          break
        case 'toggleSettings':
          // ⌘, 開いていて表示中なら閉じ、それ以外は開いて前に出す
          if (settingsOpen && centerTab === 'settings') closeSettings()
          else openSettings()
          break
        case 'showOnboarding':
          reopenOnboarding()
          break
        case 'toggleGallery':
          setGallery((open) => {
            window.location.hash = open ? '' : 'gallery'
            return !open
          })
          break
      }
    })
  }, [browserState.viewport, changeMode, toggleRecording, workspace.folderPath, files.activeFile, files.save, settingsOpen, centerTab, openSettings, closeSettings, reopenOnboarding])

  // #gallery で直接開けるようにする（E2Eが撮影に使う）
  useEffect(() => {
    const sync = () => setGallery(galleryRequested())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => installTestHooks(), [])

  const onTerminalReady = useCallback(() => {
    console.log('[startup] ターミナル利用可能')
  }, [])

  const commitSplit = useCallback((ratio: number) => {
    void window.ade.invoke('settings:splitRatio', ratio)
  }, [])

  const changeTerminalDock = useCallback((dock: Dock) => {
    setLayout((prev) => withPanel(prev, 'terminal', { dock }))
  }, [])

  /** Resource Manager の行から移る。別のプロジェクトなら先に切り替え、エディタへ戻す */
  const showInProject = useCallback(async (projectId: string | null) => {
    changeMode('editor')
    if (projectId && projectId !== workspace.projectId) {
      setWorkspace(await window.ade.invoke('project:switch', projectId))
      // ターミナルのタブが新しいプロジェクトに切り替わってから知らせる
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
  }, [changeMode, workspace.projectId])
  const openTerminalFromResources = useCallback((projectId: string | null, terminalId: string) => void run(async () => {
    await showInProject(projectId)
    window.dispatchEvent(new CustomEvent('ade:focus-terminal', { detail: { id: terminalId } }))
  }), [run, showInProject])
  const openPageFromResources = useCallback((projectId: string | null) => void run(async () => {
    await showInProject(projectId)
    setCenterTab('browser')
  }), [run, showInProject])
  /** アカウントの「管理…」。設定のページのアカウント節を開く */
  const manageAccounts = useCallback(() => openSettings('accounts'), [openSettings])

  const elapsed = `${Math.floor(recordStatus.elapsedMs / 60000).toString().padStart(2, '0')}:${Math.floor(recordStatus.elapsedMs / 1000 % 60).toString().padStart(2, '0')}`

  /*
   * 見本データは「部品見本」と「E2Eの撮影」でだけ出す（window.ade.demo）。
   * 通常起動では実データだけを出し、無ければ空状態にする。
   * 架空のレビューや指摘が製品の画面に出ないようにするため。
   * 次の工程では、この3つに実データを渡すだけでよい（型は各部品が正本）。
   */
  const showDemo = window.ade.demo && workspace.folderPath !== null
  const sessions = history.length ? history.map(toReviewSession) : showDemo ? demoSessions() : []
  const findings = showDemo ? demoFindings() : []
  const capture = showDemo ? demoCapture() : { ...EMPTY_CAPTURE, microphone: captureMic ? t('capture.summary.defaultMic') : t('capture.summary.noRecording'), transcription: transcription === 'openai' ? t('capture.summary.openai') : transcription === 'compatible' ? t('capture.summary.compatible') : transcription !== 'local' ? t('capture.summary.provider', { label: providerLabel(STT_PROVIDER_PRESETS[transcription], t) }) : available.localReady ? t('capture.summary.local') : t('capture.summary.localMissing'), organizer: t('capture.summary.organizer') }
  const selectedSession = sessions.find((s) => s.id === sessionId)

  const wsGrid = workspaceGrid(layout)
  const splitGrid = mainSplitGrid(terminalDock, layout.panels.terminal.visible)
  const footer = layout.footer

  return (
    <div className="app" data-mode={mode}>
      {/*
       * 両方のモードをDOMに残し、表示だけを切り替える。
       * 片方を unmount すると、内蔵ブラウザの置き場所だけでなく
       * ターミナルのPTY（＝起動中のAgent）も失われるため。
       */}
      <div
        className={`shell shell--editor${footer.visible && footer.dock === 'top' ? ' shell--footer-top' : ''}`}
        hidden={mode !== 'editor'}
        style={{ gridTemplateRows: footer.visible
          ? footer.dock === 'top'
            ? 'var(--size-titlebar) var(--size-statusbar) minmax(0, 1fr)'
            : 'var(--size-titlebar) minmax(0, 1fr) var(--size-statusbar)'
          : 'var(--size-titlebar) minmax(0, 1fr)' }}
      >
        <TitleBar
          workspace={workspace}
          projects={projects}
          mode={mode}
          recording={recording}
          onChangeMode={changeMode}
          onProjectMenuChange={setProjectMenuOpen}
          onToggleRecording={toggleRecording}
          onOpenSettings={() => openSettings()}
          busy={recordBusy}
        />

        {/* 列と行は配置（layout）から作る。隠したパネルも大きさ 0 で残す（src/shared/layout.ts） */}
        <div
          className={`workspace${sidebarOpen ? '' : ' workspace--narrow'}${explorerOpen ? ' workspace--explorer' : ''}`}
          style={{ gridTemplateColumns: wsGrid.columns, gridTemplateRows: wsGrid.rows, gridTemplateAreas: wsGrid.areas }}
        >
          {/*
            * 折りたたみは「外す」のではなく、枠の幅を 0 にして隠す。
            * 外すと格子の列がずれて、本体が幅0の列に落ちてしまう。
            * 枠（.sidebar-slot）が切り取り、中身は240pxのまま滑り出る。
            */}
          <div className="sidebar-slot" aria-hidden={!sidebarOpen} style={{ gridArea: 'projects' }} data-dock={layout.panels.projects.dock}>
            <ErrorBoundary name="left-sidebar">
            <Sidebar
              projects={projects}
              activeProjectId={workspace.projectId ?? null}
              sessions={sessions}
              selectedId={sessionId}
              onSelect={(id) => {
                setSessionId(id)
                setCenterTab('findings')
                // 別のプロジェクトの履歴から選ぶと history はまだ前のプロジェクトのもの。見本だけを除いて読む
                if (!(showDemo && !history.length && DEMO_SESSION_IDS.includes(id))) void run(async () => { setReview(await window.ade.invoke('review:load', id)); await refreshHistory() })
              }}
              onStartRecording={toggleRecording}
              onHistoryChanged={(deleted) => {
                // 開いているレビューを消したら、確認画面も閉じる
                if (sessionId && deleted.includes(sessionId)) { setSessionId(null); setReview(null) }
                void run(refreshHistory)
              }}
            />
            </ErrorBoundary>
          </div>

          <div
            className={`main-split main-split--${terminalDock}${layout.panels.terminal.visible ? '' : ' main-split--no-terminal'}`}
            style={{
              '--split-left': `${(splitRatio * 100).toFixed(3)}%`,
              gridArea: 'main',
              gridTemplateColumns: splitGrid.columns,
              gridTemplateRows: splitGrid.rows,
              gridTemplateAreas: splitGrid.areas
            } as React.CSSProperties}
          >
            <section className="pane pane--browser" aria-label={t('app.reviewTarget')}>
              <ErrorBoundary name="center">
              <CenterTabs
                active={centerTab}
                pageTitle={browserState.title}
                findingCount={review?.document.items.length ?? findings.length}
                onChange={setCenterTab}
                files={files.files}
                onCloseFile={files.requestClose}
                explorerOpen={explorerOpen}
                onToggleExplorer={() => setExplorerOpen((open) => !open)}
                order={centerOrder}
                onReorder={setCenterOrder}
                settingsOpen={settingsOpen}
                onCloseSettings={closeSettings}
              />
              {centerTab === 'settings' && settingsOpen ? (
                <ErrorBoundary name="settings">
                <SettingsPage
              value={{ captureMic, micDeviceId, captureSystemAudio, language, transcription, keepDays, stayFeedbackOnStop }}
              onChange={changeCaptureFromSettings}
              recording={recording}
              micDevices={micDevices}
              available={available}
              onAvailabilityChange={() => /* 失敗は main の IPC が送る */ void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined)}
              onPickModel={() => void run(async () => { await window.ade.invoke('capture:model'); setAvailable(await window.ade.invoke('capture:availability')) })}
              onModelChanged={() => /* 失敗は main の IPC が送る */ void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined)}
              agents={agents}
              onAgentsChange={changeAgents}
              agentPrompt={agentPrompt}
              onAgentPromptChange={changeAgentPrompt}
                  focus={settingsFocus}
                />
                </ErrorBoundary>
              ) : isFileTab(centerTab) ? (
                files.activeFile && (
                  <ErrorBoundary name="editor">
                  <Suspense fallback={<div className="editor-area" />}>
                    <FileEditor file={files.activeFile} editor={files} />
                  </Suspense>
                  </ErrorBoundary>
                )
              ) : centerTab === 'browser' ? (
                <ErrorBoundary name="browser">
                  <BrowserToolbar
                    state={browserState}
                    urlInputRef={urlInputRef}
                    project={projects.projects.find((p) => p.id === workspace.projectId) ?? null}
                    onOverlayChange={setUrlDialogOpen}
                  />
                  <BrowserSlot
                    viewport={browserState.viewport}
                    slotRef={mode === 'editor' && viewVisible ? slotRef : noopRef}
                    empty={emptyReason}
                    loadError={browserState.loadError}
                    onOpenFolder={openFolder}
                    onNavigate={navigate}
                  />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary name="findings">
                {review ? <ReviewFindings terminalId={activeTerminal} review={review} onUpdate={(next) => { setReview(next); void refreshHistory() }} /> : <FindingsList findings={findings} sessionLabel={selectedSession?.label} />}
                </ErrorBoundary>
              )}
              </ErrorBoundary>
            </section>

            {layout.panels.terminal.visible && <Splitter
              ratio={splitRatio}
              onChange={setSplitRatio}
              onCommit={commitSplit}
              orientation={splitGrid.orientation}
              reverse={splitGrid.reverse}
              onDragChange={setSplitDragging}
            />}

            {projectsLoaded && terminalsAllowed ? (
              <ErrorBoundary name="terminal" as="section" className="terminal-pane">
              <TerminalPane
                layoutKey={layoutKey}
                onReady={onTerminalReady}
                commandRef={terminalCommand}
                onActiveTerminal={setActiveTerminal}
                projectId={workspace.projectId ?? null}
                cwd={workspace.folderPath}
                startupAgents={agents.startupAgents}
                onOpenFile={files.open}
                onOpenAgentSettings={() => openSettings('agents')}
              />
              </ErrorBoundary>
            ) : (
              <section className="terminal-pane" aria-label={t('app.terminal')} />
            )}
            <PanelGrip panel="terminal" area="term" hidden={!layout.panels.terminal.visible} onStart={panelDrag.start} />
          </div>

          {/* 右のファイルツリー。閉じたら列の幅を 0 にして隠す（.sidebar-slot と同じ） */}
          <div className="explorer-slot" aria-hidden={!explorerOpen} style={{ gridArea: 'files' }} data-dock={layout.panels.files.dock}>
            <ErrorBoundary name="file-tree">
            <FileExplorer
              root={workspace.folderPath}
              activePath={files.activeFile?.path ?? null}
              dirtyPaths={files.dirtyPaths}
              onOpen={files.open}
              onQuickOpen={() => setQuickOpenOpen(true)}
            />
            </ErrorBoundary>
          </div>

          {/* パネルのつまみ。掴んで画面の端へ運ぶと置き場所が変わる（PanelDock.tsx） */}
          <PanelGrip panel="projects" area="projects" hidden={!sidebarOpen} onStart={panelDrag.start} />
          <PanelGrip panel="files" area="files" hidden={!explorerOpen} onStart={panelDrag.start} />
        </div>
        <DockOverlay drag={panelDrag.drag} />

        {footer.visible && <ErrorBoundary name="footer"><StatusBar
          items={footer.items}
          onStartDrag={panelDrag.start}
          state={browserState}
          capture={capture}
          recording={recording}
          elapsed={elapsed}
          settings={{ captureMic, micDeviceId, captureSystemAudio, transcription, language }}
          onCaptureChange={changeCaptureFromFooter}
          micDevices={micDevices}
          available={available}
          level={level}
          terminalDock={terminalDock}
          onTerminalDockChange={changeTerminalDock}
          onOpenSettings={() => openSettings()}
          onPopoverChange={setFooterPopoverOpen}
          onOpenTerminal={openTerminalFromResources}
          onOpenPage={openPageFromResources}
          onManageAccounts={manageAccounts}
        /></ErrorBoundary>}
      </div>

      <div className="shell shell--feedback" hidden={mode !== 'feedback'}>
        <FeedbackToolbar
          state={browserState}
          recording={recording}
          elapsed={elapsed}
          tool={tool}
          level={level}
          captureMic={captureMic}
          onToolChange={selectTool}
          paused={recordStatus.state === 'paused'}
          busy={recordBusy}
          onPause={() => void run(async () => setRecordStatus(await window.ade.invoke(recordStatus.state === 'paused' ? 'recording:resume' : 'recording:pause')))}
          onClear={() => void run(async () => { await window.ade.invoke('annotation:clear') })}
          onToggleRecording={toggleRecording}
          onBackToEditor={() => changeMode('editor')}
          target={captureTarget}
          onPickTarget={() => setTargetPickerOpen(true)}
          notice={notice}
          targetsOpen={targetsOpen}
          onToggleTargets={() => setTargetsOpen((open) => !open)}
        />
        {/* 内蔵ブラウザと、右のレビュー対象の一覧。対象を押すと録画したまま切り替わる */}
        <div className={`fb-body${targetsOpen ? ' has-targets' : ''}`} style={targetsOpen ? { gridTemplateColumns: `minmax(0, ${targetsRatio}fr) var(--size-splitter) minmax(0, ${1 - targetsRatio}fr)` } : undefined}>
          <ErrorBoundary name="feedback-browser">
          <BrowserSlot
            viewport={browserState.viewport}
            slotRef={mode === 'feedback' && viewVisible ? slotRef : noopRef}
            empty={emptyReason}
            loadError={browserState.loadError}
            onOpenFolder={openFolder}
            onNavigate={navigate}
          />
          </ErrorBoundary>
          {targetsOpen && <>
            <Splitter
              ratio={targetsRatio}
              onChange={setTargetsRatio}
              onCommit={(ratio) => writeLocal('ade.feedback.targetsRatio', String(ratio))}
              onDragChange={setSplitDragging}
            />
            <ErrorBoundary name="review-targets">
            <ReviewTargetsPanel
              project={projects.projects.find((p) => p.id === workspace.projectId) ?? null}
              openFiles={files.files.map((f) => f.path)}
              currentUrl={browserState.url}
              addedFile={addedTargetFile}
              onOpenUrl={navigate}
              onOpenEditor={(path) => { files.open(path); changeMode('editor') }}
              onPickFile={() => { setQuickOpenForTarget(true); setQuickOpenOpen(true) }}
              onClose={() => setTargetsOpen(() => false)}
            />
            </ErrorBoundary>
          </>}
        </div>
      </div>

      {quickOpenOpen && <QuickOpen
        onOpen={(path) => (quickOpenForTarget ? setAddedTargetFile({ path, at: Date.now() }) : files.open(path))}
        onClose={() => { setQuickOpenOpen(false); setQuickOpenForTarget(false) }}
      />}
      {files.pendingClose && <UnsavedChangesDialog name={files.pendingClose.name} onChoose={files.resolveClose} />}
      {targetPickerOpen && <CaptureTargetPicker
        value={captureTarget}
        pageTitle={browserState.title || browserState.url}
        onChoose={(target) => { chooseTarget(target); setTargetPickerOpen(false) }}
        onStart={(target) => { chooseTarget(target); setTargetPickerOpen(false); toggleRecording() }}
        onClose={() => setTargetPickerOpen(false)}
      />}
      {onboardingOpen && <OnboardingFlow
        onboarding={onboarding ?? null}
        onPersist={persistOnboarding}
        agents={agents}
        onAgentsChange={changeAgents}
        projects={projects}
        voice={{
          transcription,
          language,
          available,
          onTranscriptionChange: (next) => changeCaptureFromSettings({ transcription: next }),
          onLanguageChange: (next) => changeCaptureFromSettings({ language: next }),
          onAvailabilityChange: () => void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined),
          onPickModel: () => void run(async () => { await window.ade.invoke('capture:model'); setAvailable(await window.ade.invoke('capture:availability')) }),
          onModelChanged: () => void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined)
        }}
      />}
      {/* 部品見本。開発時だけ開く（表示メニュー → 部品見本、または #gallery）*/}
      {gallery && (
        <div className="app__gallery">
          <Gallery
            onClose={() => {
              window.location.hash = ''
              setGallery(false)
            }}
          />
        </div>
      )}
    </div>
  )
}
