import type { AnnotationColor } from './annotation'
import type { LayoutPrefs } from './layout'
import type { DecisionPreferences } from './decision'
import type { StarPromptState } from './starPrompt'
import type { AiEndpointConfig, AiVendor, LlmApiProvider, OrganizeRunnerId, SttRemoteProvider } from './aiProviders'
/**
 * メイン / preload / renderer が共有する型。
 * ここに置いたものだけが IPC の境界を越える。
 */

import type { LocalePreference } from './i18n'
import type { SttLanguageCode } from './sttLanguages'
import type { OnboardingState } from './onboarding'
import type { AccountLoginRequest, AgentAccountsSettings } from './accounts'
export type { AccountLoginRequest, AgentAccountsSettings } from './accounts'

/**
 * OS種別。renderer は Node の型定義を読まないため、ここで宣言して共有する。
 * 値は Node の `process.platform` と同じ。
 */
export type PlatformName =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32'

/** 5.2 モード。録画はフィードバックモードで行う（MODE-3） */
export type AppMode = 'editor' | 'feedback'

/** WS-3 内蔵ブラウザの表示幅 */
export type Viewport = 'desktop' | 'mobile'

/** 代表的な端末サイズ（スマホ幅のエミュレーション） */
export const MOBILE_PRESET = {
  label: 'iPhone 14',
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
} as const

/** renderer が実測した、内蔵ブラウザを置く領域（CSSピクセル） */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 内蔵ブラウザの状態。ツールバーの活性制御に使う */
export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  viewport: Viewport
  /** ページを開けなかったときの理由（利用者向けの文）。開けていれば無い */
  loadError?: string
}

/** 開いているプロジェクト */
export interface WorkspaceState {
  folderPath: string | null
  folderName: string | null
  /** 開いている登録済みプロジェクト。未登録のフォルダなら null */
  projectId?: string | null
}

// ───────────────────────── プロジェクト・Agent起動（Orca準拠）─────────────────────────

/**
 * プロジェクトの種類。確認先（ターゲット）に何を持つかが変わる（src/shared/projectTargets.ts）。
 *   web     … URL を内蔵ブラウザで開く
 *   mobile  … モバイル Web の URL か、シミュレータ／エミュレータ（起動コマンドとウインドウ）
 *   desktop … 起動コマンドと、録画するウインドウ（Electron / Tauri の開発サーバーなら URL も）
 *   other   … 起動コマンド・ウインドウ・URL を自由に
 */
export type ProjectKind = 'web' | 'mobile' | 'desktop' | 'other'

/**
 * プロジェクトごとに登録する確認先（ターゲット）。名前は自由で、件数の上限は無い。
 * 名前の ProjectUrl は、URL だけを持っていた頃の名残（設定ファイルの互換のため変えない）。
 * url・launchCommand・windowMatch のどれか1つは持つ。
 */
export interface ProjectUrl {
  id: string
  /** 表示名（例: local, dev, prd, staging, iOS sim） */
  label: string
  /** 内蔵ブラウザで開く URL */
  url?: string
  /** 押したときにプロジェクトのフォルダのターミナルで走らせるコマンド（例: pnpm tauri dev） */
  launchCommand?: string
  /** 録画するウインドウを選ぶための名前（アプリ名やウインドウ名の一部。例: Simulator） */
  windowMatch?: string
}

/** 確認先。ProjectUrl と同じもの（新しいコードはこちらの名前を使う） */
export type ProjectTarget = ProjectUrl

/** project:update で送るもの。id のほかは変えたい項目だけでよい */
export type ProjectUpdate = Pick<Project, 'id'> & Partial<Pick<Project, 'name' | 'kind' | 'urls'>>

/** 事前に登録したフォルダ。ターミナルは常にここをカレントにして起動する（worktreeは使わない） */
export interface Project {
  id: string
  name: string
  folderPath: string
  /** 種類。未設定は web（URL だけを登録していた頃の設定） */
  kind?: ProjectKind
  /** 確認先（並びは利用者が決めた順）。互換のため名前は urls のまま */
  urls: ProjectUrl[]
  /** 前に開いていたときの作業の状態。切り替えて戻ったときと再起動したときに元へ戻す（src/shared/projectSession.ts） */
  session?: ProjectSession
}

/** プロジェクトごとに覚える作業の状態。パスと URL だけで、中身や履歴は持たない */
export interface ProjectSession {
  /** 内蔵ブラウザで開いていた URL */
  url?: string
  /** 中央のタブの選択。ファイルは `file:<相対パス>`（根を外して覚える） */
  centerTab?: string
  /** 開いていたファイル（プロジェクトからの相対パス、開いた順） */
  openFiles?: string[]
  /** 表示していたレビュー */
  reviewId?: string
}

export interface ProjectsState {
  projects: Project[]
  activeProjectId: string | null
}

/**
 * ターミナルからそのまま起動できる組み込みのエージェント（Orca の TuiAgent のうち本システムで扱うもの）。
 * 表示名・検出コマンド・既定の引数は src/shared/agentCatalog.ts
 */
export type BuiltinAgent =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'copilot'
  | 'devin'
  | 'opencode'
  | 'amp'
  | 'droid'
  | 'kiro'
  | 'aider'
  | 'ante'
  | 'antigravity'
  | 'aug'
  | 'autohand'
  | 'blackbox'
  | 'cline'
  | 'codebuddy'
  | 'codebuff'
  | 'command-code'
  | 'continue'
  | 'crush'
  | 'dsh'
  | 'forge'
  | 'freebuff'
  | 'goose'
  | 'grok'
  | 'hermes'
  | 'junie'
  | 'kilo'
  | 'kimi'
  | 'letta'
  | 'mimo-code'
  | 'mistral-vibe'
  | 'muse'
  | 'omp'
  | 'openclaude'
  | 'openclaw'
  | 'openhands'
  | 'pi'
  | 'prime-agent'
  | 'qoder'
  | 'qwen-code'
  | 'roo'
  | 'rovo'
  | 'trae'
  | 'zcode'

/** 利用者が登録したエージェントの id（`custom:<名前から作った語>`） */
export type CustomAgentId = `custom:${string}`

export type TuiAgent = BuiltinAgent | CustomAgentId

/** アカウント切り替え・使用量の対象。設定フォルダを分けられる Claude Code / Codex だけ */
export type AccountAgent = 'claude' | 'codex'

/** Agentの起動コマンド。Orca の agentCmdOverrides / agentDefaultArgs に相当 */
export interface AgentLaunchConfig {
  command: string
  args: string
}

/** 利用者が登録したエージェント（Orca のカタログに無い CLI や、ラッパースクリプト） */
export interface CustomAgent extends AgentLaunchConfig {
  id: CustomAgentId
  name: string
  /** 「Agentへ送信」で同定に使う前面プロセス名。省略時は command の先頭語 */
  processName?: string
  /** アイコンに出す1〜2文字。省略時は名前の頭文字 */
  icon?: string
}

export interface AgentPreferences {
  /** 組み込みのエージェントの起動コマンド（既定は Orca と同じ。権限確認を省くフラグ付き） */
  launch: Record<BuiltinAgent, AgentLaunchConfig>
  customAgents: CustomAgent[]
  /** メニューに出さないエージェント（Orca の disabledTuiAgents） */
  disabledAgents: TuiAgent[]
  /** プロジェクトを開いたとき自動で開くAgentタブ（順序どおり）。空なら素のシェル1つ */
  startupAgents: TuiAgent[]
}

/** 設定画面・メニューに出す1件（main が検出結果と設定を合わせて返す） */
export interface AgentOption {
  id: TuiAgent
  label: string
  custom: boolean
  /** PATH 上にコマンドがある（Orca の検出と同じ考え方） */
  installed: boolean
  /** 無効にしていない */
  enabled: boolean
  command: string
  args: string
  /** 組み込みの既定値（カスタムは null） */
  defaultCommand: string | null
  defaultArgs: string | null
  homepageUrl: string | null
  /** カスタムのアイコンの文字（設定したときだけ） */
  icon?: string
}

export { DEFAULT_AGENT_PREFERENCES, TUI_AGENT_LABEL } from './agentCatalog'

export interface TerminalCreateOptions {
  size: TerminalSize
  /** 省略時は開いているプロジェクトのフォルダ */
  cwd?: string | null
  /** 指定するとシェル起動後にそのAgentを起動する */
  agent?: TuiAgent | null
  /** 指定するとシェル起動後に、そのアカウントの設定フォルダでログインを始める */
  accountLogin?: AccountLoginRequest | null
  /** 指定するとシェル起動後にこの1行を実行する（設定の GitHub 節の `gh auth login` など） */
  command?: string | null
  /** command が終わったらその終了コードでシェルも閉じる（Agent のインストール。結果は terminal:exit の終了コードで受け取る） */
  exitWhenDone?: boolean
  /** タブ名。省略時は Agent 名やシェル名 */
  title?: string | null
}

/** 復元対象の設定（WS-1 ＋ 分割幅） */
export interface Settings {
  whisperModel?: string
  capture?: CapturePreferences
  folderPath: string | null
  url: string
  splitRatio: number
  /** 以前の設定（ターミナルを右か下か）。読み込むときに layout.panels.terminal へ移し、以後は書かない */
  terminalDock?: TerminalDock
  /** パネルの置き場所と表示、フッターの項目（src/shared/layout.ts） */
  layout?: LayoutPrefs
  /** 配色。省略時は OS に追従（system） */
  theme?: ThemePreference
  /** 画面の言語。省略時は OS に追従（system。日本語の OS なら日本語、それ以外は英語）。文字起こしの言語とは別 */
  locale?: LocalePreference
  viewport: Viewport
  projects: Project[]
  activeProjectId: string | null
  agents: AgentPreferences
  /** Claude Code / Codex のアカウント切り替え。省略時はどちらもシステムの既定アカウント */
  agentAccounts?: AgentAccountsSettings
  /** Agentへ渡す1行の指示のテンプレート（{{path}} = feedback.md の絶対パス、{{relpath}} = 相対パス）。未設定・空なら既定文 */
  agentPrompt?: string
  /** 「指摘を整理」の実行方法と、API の接続先 */
  organizer?: OrganizerPreferences
  /** 判定モデル（「フィードバックどおりにできたか」の判定）の接続先。キーは入れない（src/shared/decision.ts） */
  decision?: DecisionPreferences
  /** クラッシュレポートを Sentry へ送るか。未設定は ON（src/shared/telemetry.ts） */
  crashReports?: boolean
  /** 初回起動の「クラッシュレポートを送ります」の案内を出し終えたか */
  crashReportsNoticeShown?: boolean
  /** 初回起動のセットアップの進み具合（src/shared/onboarding.ts）。未設定なら出す */
  onboarding?: OnboardingState
  /** GitHub の star のお願いの状態（state.json に置く。src/shared/starPrompt.ts）。省略時はまだ一度も出していない */
  starPrompt?: StarPromptState
  /** フィードバックモードの右パネル（レビュー対象）の開閉と幅。省略時は開いていて 0.78 */
  feedbackTargets?: FeedbackTargetsPrefs
}

export interface FeedbackTargetsPrefs {
  visible?: boolean
  /** ページ側の幅の割合（残りがパネル） */
  ratio?: number
}

/** settings.json を読めない理由（JSON の誤り・スキーマの違反）。直るまで取り込まず、ファイルも上書きしない */
export interface SettingsFileError {
  kind: 'parse' | 'schema'
  message: string
  /** 1 始まり */
  line?: number
  column?: number
  /** スキーマの違反の場所（/capture/keepDays） */
  path?: string
}

/** 設定のページに出す settings.json の情報 */
export interface SettingsFileInfo {
  path: string
  dir: string
  schemaPath: string
  statePath: string
  error: SettingsFileError | null
  /** 平文の apiKey が書かれている場所（警告用。値は渡さない） */
  plaintextKeys: string[]
}

/** 開いているターミナルの一覧の1件（main の TerminalManager.list()。読み取り専用） */
export interface TerminalSessionInfo {
  id: string
  pid: number
  cwd: string
  /** タブ名（Agentなら 'Claude Code' など、シェルなら「1: zsh」） */
  title: string
  agent: TuiAgent | null
}

/** 画面の読み込み直しのあと、生きているターミナルにつなぎ直したときに返すもの */
export interface TerminalAttachInfo extends TerminalSessionInfo {
  /** 直近の出力（スクロールバック）。xterm に流し直す */
  history: string
  /** 今の PTY の大きさ。流し直す前に xterm をこの大きさにする（出力はこの幅で折り返されている） */
  size: TerminalSize
}

export interface TerminalTabInfo {
  id: string
  title: string
  agent?: TuiAgent | null
  cwd?: string
}

export interface TerminalSize {
  cols: number
  rows: number
}

/** 起動時間の計測結果（NF-5） */
export interface StartupTiming {
  /** プロセス生成から操作可能になるまで（ms） */
  totalMs: number
  /** 内訳 */
  marks: Record<string, number>
}

/**
 * メニュー（＝キーボードショートカット）から renderer へ渡す指示。
 * 修飾キーは Electron の `CmdOrCtrl` に任せ、OSごとの分岐をコードに書かない。
 */
export type MenuCommand =
  | 'toggleRecording'
  | 'toggleMode'
  | 'newTerminal'
  | 'closeTerminal'
  /** ⌘D / ⌘⇧D フォーカス中のペインを右／下に分割する（TerminalPane が直接受ける） */
  | 'splitTerminalRight'
  | 'splitTerminalDown'
  | 'focusUrl'
  | 'reloadPage'
  | 'toggleViewport'
  /** 左サイドバー（レビュー一覧）の開閉 */
  | 'toggleSidebar'
  /** 共通部品の見本（開発時のみ。URL の #gallery でも開ける） */
  | 'toggleGallery'
  /** ⌘P ファイルを名前で開く */
  | 'quickOpen'
  /** ⌘S 開いているファイルを保存する */
  | 'saveFile'
  /** 右のファイルツリー（エクスプローラ）の開閉 */
  | 'toggleExplorer'
  /** フィードバックモードの右パネル（レビュー対象の一覧）の開閉 */
  | 'toggleTargets'
  /** ⌘J ターミナルの表示・非表示（Orca・VS Code のパネルの開閉と同じ） */
  | 'toggleTerminalPanel'
  /** フッターの表示・非表示 */
  | 'toggleFooter'
  /** ⌘, 設定のページ（中央のタブ）の開閉 */
  | 'toggleSettings'
  /** ヘルプ → セットアップをもう一度（オンボーディングを開き直す） */
  | 'showOnboarding'
  /** ヘルプ → GitHub で star（src/shared/starPrompt.ts） */
  | 'starOnGitHub'

// ───────────────────────── 録画（要件 5.3・5.4）─────────────────────────

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopping'

/** 音声の取得系統。pipeline の AudioSource と同じ値 */
export type AudioSourceKind = 'mic' | 'system'

/** ペン／四角の枠／どれでもない（PEN-2）。依頼は声と書き込みで行うので、画面に文字を置く道具（旧 TXT-1）は無い */
export type AnnotationMode = 'off' | 'pen' | 'rect'

/** 書き込みの「元に戻す／やり直す」ができるか（ツールバーのボタンの有効・無効） */
export interface AnnotationHistory {
  canUndo: boolean
  canRedo: boolean
}

/** ページに焦点があるときに押された、書き込みの道具の切り替えキー（P / B・R / V・Esc / C） */
export type AnnotationShortcut = 'pen' | 'rect' | 'off' | 'color'

/** 画面に出す録画の状態（REC-5） */
export interface RecordingStatus {
  state: RecordingState
  /** 一時停止ぶんを除いた経過時間(ms) */
  elapsedMs: number
  videoBytes: number
  frameCount: number
  eventCount: number
}

/** 入力レベル（REC-3 のレベル表示用）。0〜1 */
export interface AudioLevel {
  source: AudioSourceKind
  rms: number
  peak: number
}

/** 録画を始めるときの指定 */
export interface StartRecordingOptions {
  language?: SttLanguageCode
  /** 相手の声も録る（AUD-1） */
  captureSystemAudio: boolean
  micDeviceId?: string
  captureMic?: boolean
  transcription?: SttProvider
  /** 録る対象。省略時は内蔵ブラウザ */
  captureTarget?: CaptureTarget
  /** このレビュー（ID）に追記する（Findings の「このレビューに追加で録る」）。省略時は新しいレビュー */
  appendTo?: string
}

/**
 * 録画の対象（REC-2 の拡張）。
 * browser は内蔵ブラウザ（既定。OSの画面収録の許可は要らない）。
 * screen / window は desktopCapturer の対象で、sourceId はその ID（'screen:…' / 'window:…'）。
 * ID は再起動などで変わるので、見つからないときは displayId・名前で探し直す（captureTarget.ts）。
 */
export type CaptureTarget =
  | { kind: 'browser' }
  | { kind: 'screen' | 'window'; sourceId: string; name: string; displayId?: string }

/** 対象の選択画面に出す1件 */
export interface CaptureSourceInfo {
  id: string
  kind: 'screen' | 'window'
  name: string
  displayId?: string
  /** サムネイル（data URL）。取れなければ空文字 */
  thumbnail: string
  /** ウインドウのアプリのアイコン（data URL） */
  appIcon?: string
}

export interface CaptureSourceList {
  /** macOS の画面収録の許可。macOS 以外は常に 'granted' */
  screenAccess: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  sources: CaptureSourceInfo[]
}

export const DEFAULT_URL = 'about:blank'
/** 以前のターミナルの置き場所（右か下）。今は layout.panels.terminal.dock（左・右・上・下）が正本 */
export type TerminalDock = 'right' | 'bottom'

/** 配色の設定。system は OS のライト／ダークに追従する */
export type ThemePreference = 'system' | 'light' | 'dark'

export const DEFAULT_SPLIT_RATIO = 0.6
export const MIN_SPLIT_RATIO = 0.2
export const MAX_SPLIT_RATIO = 0.85

/**
 * 文字起こしの接続先。各自が自分のコストで使う。
 * local は端末内の whisper.cpp（無料）、openai は自分の OpenAI のキー、
 * compatible は OpenAI 互換のエンドポイント（自前の GPU で動かすサーバーや Groq など）。
 */
export type SttProvider = 'local' | SttRemoteProvider

/** 文字起こしのキーの出どころ。値そのものは renderer へ渡さない。config は settings.json の平文の apiKey、configEnv は apiKeyEnv */
export type SttKeySource = 'saved' | 'session' | 'env' | 'config' | 'configEnv' | null

/** capture:availability の戻り値 */
/** 端末内の文字起こしのモデル（whisper.cpp の ggml）。設定の「モデルをダウンロード」に出す */
export type WhisperModelName = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo-q5_0' | 'large-v3-turbo'

export interface WhisperModelStatus {
  id: WhisperModelName
  bytes: number
  /** 既定（日本語・英語の両方で実用になる大きさ） */
  recommended: boolean
  downloaded: boolean
  /** 途中まで落とした大きさ。0 でなければ続きから再開する */
  partialBytes: number
}

/** capture:whisperModels の戻り値 */
export interface WhisperModelList {
  models: WhisperModelStatus[]
  /** whisper-cli が見つかったか。無ければ installHint を案内する */
  binaryFound: boolean
  installHint: { command?: string; url: string }
  /** 今落としているモデル */
  downloading: WhisperModelName | null
  /** 使うように選ばれているモデル（userData/models のものだけ） */
  selected: WhisperModelName | null
}

export interface WhisperModelProgress {
  modelId: WhisperModelName
  /** download は受信中、verify は sha256 の照合中 */
  phase: 'download' | 'verify'
  receivedBytes: number
  totalBytes: number
}

export interface SttAvailability {
  localReady: boolean
  /**
   * encrypted は OS の鍵で暗号化して保存、session は起動中だけ保持（Linux で鍵束が無い場合など）、
   * dev は開発版なので保存しない（起動中だけ保持。Keychain の確認を出さないため）
   */
  keyStorage: 'encrypted' | 'session' | 'dev'
  /** 提供元（vendor）ごとのキーの出どころ。値そのものは渡さない */
  keys: Record<AiVendor, SttKeySource>
  /** 文字起こしの提供元ごとに、送れる状態か（キーと接続先が揃っている） */
  stt: Record<SttRemoteProvider, boolean>
  /** 「指摘を整理」を API で呼ぶ提供元ごとに、呼べる状態か */
  llm: Record<LlmApiProvider, boolean>
}

export interface CapturePreferences { captureMic: boolean; captureSystemAudio: boolean; transcription: SttProvider; language: SttLanguageCode; micDeviceId?: string; keepDays: number; stayFeedbackOnStop: boolean
  /** 前回選んだ録画の対象。省略時は内蔵ブラウザ */
  captureTarget?: CaptureTarget
  /** 録画中の書き込み（ペン・四角の枠）の色。省略時はローズ */
  annotationColor?: AnnotationColor
  /** 以前の compatible の接続先。読み込むときに sttEndpoints.compatible へ移し、以後は書かない */
  baseUrl?: string
  model?: string
  /** 文字起こしの提供元ごとの上書き（Base URL・モデル・タイムアウト・追加のヘッダー）。省略時はプリセット */
  sttEndpoints?: Partial<Record<SttRemoteProvider, AiEndpointConfig>>
  /** 1レビューあたりの概算の費用上限(USD)。null は上限なし。省略時は $1 */
  costLimitUsd?: number | null }

/** 「指摘を整理」の設定。CLI（Claude Code / Codex）か、API キーで直接 LLM を呼ぶか */
export interface OrganizerPreferences {
  /** 前回選んだ実行方法。省略時は codex */
  runner?: OrganizeRunnerId
  /** API の提供元ごとの上書き。省略時はプリセット（src/shared/aiProviders.ts） */
  endpoints?: Partial<Record<LlmApiProvider, AiEndpointConfig>>
  /** CLI の runner に渡すモデル名。省略時は各 CLI の既定 */
  cliModels?: Partial<Record<'codex' | 'claude-code', string>>
}
