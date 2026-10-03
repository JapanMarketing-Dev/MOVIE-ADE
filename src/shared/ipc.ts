import type { AiEndpointConfig, AiVendor, LlmApiProvider, OrganizeRunnerId, SttRemoteProvider } from './aiProviders'
import type {
  AnnotationMode,
  AppMode,
  AgentPreferences,
  CapturePreferences,
  CaptureSourceList,
  CaptureTarget,
  SttAvailability,
  OrganizerPreferences,
  WhisperModelList,
  WhisperModelName,
  WhisperModelProgress,
  Project,
  ProjectsState,
  TerminalCreateOptions,
  AudioLevel,
  BrowserState,
  MenuCommand,
  PlatformName,
  RecordingStatus,
  Settings,
  StartRecordingOptions,
  StartupTiming,
  TerminalSize,
  ThemePreference,
  TerminalTabInfo,
  AccountAgent,
  AgentOption,
  ViewBounds,
  Viewport,
  WorkspaceState
} from './types'
import type { ReviewData, ReviewEdit, ReviewLabelPatch, ReviewSummary, ReviewFrame } from './review'
import type { AccountLoginRequest, AgentAccountAddResult, AgentAccountsState } from './accounts'
import type { AccountUsage, UsageState } from './usage'
import type { UpdateCheckResult } from './appVersion'
import type { LayoutPrefs } from './layout'
import type { ResolvedTheme } from './theme'
import type { LocalePreference, SupportedLocale } from './i18n'
import type { ResourceKillTarget, ResourceSnapshot } from './resources'
import type { FsChangedEvent, FsEntry, FsFileList, FsReadResult, FsSearchMode, FsSearchResult, FsWriteResult } from './files'
import type { GitHubPostResult, GitHubRepoResult, GitHubReviewDraft, GitHubReviewTarget, GitHubStatus } from './github'

/**
 * IPC の全チャネルを1か所で宣言する。
 * - `IpcRequests`: renderer → main の呼び出し（ipcRenderer.invoke）
 * - `IpcEvents`:   main → renderer の通知（webContents.send）
 *
 * ハンドラ登録側（main）と呼び出し側（preload）の両方がこの型から生成されるため、
 * チャネル名・引数・戻り値のずれはコンパイルエラーになる。
 */
export interface IpcRequests {
  'app:ready': () => StartupTiming
  'app:settings': () => Settings
  /** package.json の version と、配布用にパッケージされた起動か（dev 起動なら false） */
  'app:version': () => { version: string; packaged: boolean }
  /** GitHub Releases の最新と比べるだけ。自動更新はしない */
  'app:checkUpdate': () => UpdateCheckResult
  /** 直前の確認で見つかった新しい版のページを既定のブラウザで開く */
  'app:openUpdate': () => void
  /** Resource Manager。アプリ・内蔵ブラウザ・ターミナルの CPU と RSS */
  'resources:snapshot': () => ResourceSnapshot
  /** ターミナルを止める／内蔵ブラウザのページを閉じる（about:blank にする） */
  'resources:kill': (target: ResourceKillTarget) => void
  /** 画面の読み込み直しで置き去りになったターミナルを止める。止めた数を返す */
  'resources:cleanup': () => number

  'workspace:open': () => WorkspaceState
  'workspace:current': () => WorkspaceState

  /** 登録済みプロジェクト（フォルダ＋URLプリセット） */
  'project:list': () => ProjectsState
  /** フォルダを選んで登録し、そのプロジェクトを開く。キャンセルなら null */
  'project:add': () => ProjectsState | null
  'project:switch': (id: string) => WorkspaceState
  /** 名前・URLの変更。id で既存を置き換える */
  'project:update': (project: Project) => ProjectsState
  /** 登録を外すだけ。フォルダは消さない */
  'project:remove': (id: string) => ProjectsState

  'settings:agents': (preferences: AgentPreferences) => void
  /** エージェントの一覧（設定とインストール済みかの検出を合わせたもの）。refresh で検出し直す */
  'agents:list': (refresh?: boolean) => AgentOption[]
  /** 空文字で既定文に戻す */
  'settings:agentPrompt': (template: string) => void

  /** Claude Code / Codex のアカウント。一覧を読むたびにログインの済んだ行を登録し直す */
  'accounts:list': () => AgentAccountsState
  /** 設定フォルダと「ログイン待ち」の行を作る。続けて内蔵ターミナルでログインを始める */
  'accounts:add': (agent: AccountAgent) => AgentAccountAddResult
  'accounts:rename': (agent: AccountAgent, accountId: string, label: string) => AgentAccountsState
  /** 一覧から外し、本システムが作った設定フォルダを消す */
  'accounts:remove': (agent: AccountAgent, accountId: string) => AgentAccountsState
  /** null はシステムの既定アカウント。新しく開く Agent から効く */
  'accounts:select': (agent: AccountAgent, accountId: string | null) => AgentAccountsState
  /** ログインをやり直す（ターミナルで開く指定を返す） */
  'accounts:relogin': (agent: AccountAgent, accountId: string) => AccountLoginRequest

  /** 選択中のアカウントの使用量（フッター左下）。変わると usage:changed で届く */
  'usage:get': () => UsageState
  /** force なら連打よけを越えて取り直す。そうでなければ古いもの・切り替えたものだけ */
  'usage:refresh': (force: boolean) => UsageState
  /** アカウント別の内訳（Usage ポップオーバーの「>」）。開いたときだけ取る */
  'usage:accounts': (agent: AccountAgent, force: boolean) => AccountUsage[]

  'mode:set': (mode: AppMode) => void

  'browser:setBounds': (bounds: ViewBounds | null) => void
  'browser:navigate': (url: string) => void
  'browser:back': () => void
  'browser:forward': () => void
  'browser:reload': () => void
  'browser:setViewport': (viewport: Viewport) => void
  'browser:state': () => BrowserState

  'terminal:create': (options: TerminalCreateOptions) => TerminalTabInfo
  'terminal:write': (id: string, data: string) => void
  'terminal:resize': (id: string, size: TerminalSize) => void
  'terminal:close': (id: string) => void
  'terminal:screen': (id: string, text: string) => void
  'terminal:agentState': (id: string) => { kind: string; state: string }
  /** シェルの今のカレント（分割したペインに引き継ぐ）。終了済みなら null */
  'terminal:cwd': (id: string) => string | null
  'review:send': (sessionId: string, terminalId: string) => { ok: boolean; message: string }

  'settings:splitRatio': (ratio: number) => void
  /** パネルの置き場所と表示、フッターの項目 */
  'settings:layout': (layout: LayoutPrefs) => void
  /** 配色を保存し、ネイティブ側（nativeTheme・ウインドウの背景）にも反映する */
  'settings:theme': (theme: ThemePreference) => void
  /** 画面の言語を保存し、main 側（メニュー・ダイアログ）も切り替える。戻り値は解決済みの言語 */
  'settings:locale': (locale: LocalePreference) => SupportedLocale
  /** クラッシュレポートを送るか。OFF はすぐ効く。ON は次の起動から（初期化は起動時だけ） */
  'settings:crashReports': (enabled: boolean) => void
  /** active = この起動で Sentry を初期化したか（配布版で ON のとき）。noticeShown = 初回の案内を出し終えたか */
  'telemetry:state': () => { active: boolean; enabled: boolean; noticeShown: boolean }
  /** 初回の案内を閉じた */
  'telemetry:noticeShown': () => void

  // 録画（要件 5.3・5.4）
  'recording:start': (options: StartRecordingOptions) => RecordingStatus
  'recording:pause': () => RecordingStatus
  'recording:resume': () => RecordingStatus
  'recording:stop': () => RecordingStatus
  'recording:status': () => RecordingStatus
  'annotation:setMode': (mode: AnnotationMode) => void
  'annotation:clear': () => void
  /** 省略時は開いているフォルダ。指定できるのは登録済みプロジェクトのフォルダだけ（サイドバーの入れ子表示用） */
  'review:list': (folderPath?: string) => ReviewSummary[]
  /** レビューの名前・アーカイブを変える（folderPath は登録済みプロジェクトに限る。省略時は開いているプロジェクト） */
  'review:label': (id: string, patch: ReviewLabelPatch, folderPath?: string) => void
  /** レビューを消す（.ade-movie/reviews/<日時>/ ごと）。消せた ID を返す */
  'review:delete': (ids: string[], folderPath?: string) => string[]
  'review:load': (id: string) => ReviewData
  'review:edit': (sessionId: string, edit: ReviewEdit) => ReviewData
  'review:copy': (id: string) => void
  'review:folder': (id: string) => void
  'review:restore': (id: string, t: number) => ReviewData
  /** CLI（各自の契約）か、API キーで直接（api:anthropic など） */
  'review:organize': (id: string, runner: OrganizeRunnerId) => ReviewData
  'review:frames': (id: string, itemId: string) => ReviewFrame[]
  'settings:capture': (preferences: CapturePreferences) => void
  'capture:devices': () => Array<{ id: string; label: string }>
  /** 空文字は解除。persisted は暗号化して保存できたか（false なら起動中だけ保持） */
  'capture:apiKey': (key: string, provider?: AiVendor) => { persisted: boolean }
  /** 「接続を確認」。1秒の無音を送り、届くかどうかを日本語で返す */
  'capture:testConnection': (target: { provider: SttRemoteProvider; endpoint?: AiEndpointConfig }) => { ok: boolean; message: string }
  /** 文字起こしの接続先の上書きと費用の上限を保存する（設定の文字起こしの節がその場で保存する） */
  'settings:stt': (patch: { sttEndpoints?: Partial<Record<SttRemoteProvider, AiEndpointConfig>>; costLimitUsd?: number | null }) => void
  /** 「指摘を整理」の実行方法と API の接続先を保存する */
  'settings:organizer': (prefs: OrganizerPreferences) => void
  /** 整理の API の「接続を確認」。短い質問を1回送る */
  'organize:testConnection': (target: { provider: LlmApiProvider; endpoint?: AiEndpointConfig }) => { ok: boolean; message: string }
  'capture:model': () => boolean
  'capture:availability': () => SttAvailability
  /** 端末内の文字起こしのモデルの一覧と、whisper-cli の有無 */
  'capture:whisperModels': () => WhisperModelList
  /** 落として sha256 を照合し、終わったらそのモデルを選ぶ。失敗・中止は結果で返す */
  'capture:downloadModel': (id: WhisperModelName) => { ok: true } | { ok: false; reason: 'aborted' | 'failed'; message: string }
  'capture:cancelModelDownload': () => void
  /** 録画の対象の候補（画面・ウインドウ。サムネイル付き）と、画面収録の許可 */
  'capture:sources': () => CaptureSourceList
  /** 録画の対象を覚える（次回の既定） */
  'capture:setTarget': (target: CaptureTarget) => void
  /** macOS のシステム設定（画面収録）を開く */
  'capture:openScreenSettings': () => void

  // ファイルエディタ。パスはすべて開いているプロジェクトからの相対パス（外は main が断る）
  'fs:list': (relDir: string) => FsEntry[]
  'fs:read': (relPath: string) => FsReadResult
  'fs:write': (relPath: string, content: string) => FsWriteResult
  /** クイックオープン（⌘P）用の全ファイル一覧。.gitignore に従う */
  'fs:files': () => FsFileList
  'fs:search': (query: string, mode: FsSearchMode) => FsSearchResult
  /** エディタで未保存のファイル（パス）。ウィンドウを閉じるときの確認に使う */
  'editor:unsaved': (paths: string[]) => void

  // GitHub 連携（認証は gh CLI に任せる。トークンは扱わない）
  /** `gh auth status` の読み取り。gh が無ければ ghInstalled: false */
  'github:status': () => GitHubStatus
  /** 開いているプロジェクトの origin から求めた owner/repo */
  'github:repo': () => GitHubRepoResult
  /** レビュー結果を送る前の下書き（送り先の候補と本文）。GitHub には書き込まない */
  'github:reviewDraft': (sessionId: string) => GitHubReviewDraft
  /** 確認ダイアログで承認された本文を Issue / PR コメントとして書き込む */
  'github:postReview': (sessionId: string, target: GitHubReviewTarget, body: string) => GitHubPostResult
  /** リポジトリ・作った Issue などのページを既定のブラウザで開く（GitHub のURLだけ） */
  'github:open': (url: string) => void
}

export interface IpcEvents {
  'browser:stateChanged': (state: BrowserState) => void
  'mode:changed': (mode: AppMode) => void
  'terminal:data': (id: string, data: string) => void
  'terminal:exit': (id: string, exitCode: number) => void
  'menu:command': (command: MenuCommand) => void
  'workspace:changed': (state: WorkspaceState) => void
  'projects:changed': (state: ProjectsState) => void
  /** エージェントの設定が変わった（settings:agents の保存後） */
  'agents:changed': (options: AgentOption[]) => void
  'recording:status': (status: RecordingStatus) => void
  'recording:level': (level: AudioLevel) => void
  /** 録画は続いているが、何かが取れなかった（マイク無しなど）ことを知らせる */
  'recording:warning': (message: string) => void
  'capture:modelProgress': (progress: WhisperModelProgress) => void
  'review:ready': (review: ReviewData) => void
  /** 使用量が変わった（取得中・成功・失敗） */
  'usage:changed': (state: UsageState) => void
  /** プロジェクトの中のファイルが外部（Agent など）で変わった */
  'fs:changed': (event: FsChangedEvent) => void
  /** 解決済みの配色が変わった（設定の変更、または system のときの OS の切り替え） */
  'theme:changed': (theme: ResolvedTheme) => void
  /** 解決済みの画面の言語が変わった */
  'locale:changed': (locale: SupportedLocale) => void
}

export type IpcRequestChannel = keyof IpcRequests
export type IpcEventChannel = keyof IpcEvents

export type IpcResult<C extends IpcRequestChannel> = Awaited<ReturnType<IpcRequests[C]>>
export type IpcArgs<C extends IpcRequestChannel> = Parameters<IpcRequests[C]>

/** preload が contextBridge で公開する API の形。renderer 側はこれだけを見る */
export interface AdeApi {
  invoke<C extends IpcRequestChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  on<C extends IpcEventChannel>(channel: C, listener: IpcEvents[C]): () => void
  platform: PlatformName
  /**
   * 見本データを出してよいか（E2Eの撮影用）。
   * 通常起動では false で、実データが無ければ空状態を出す。
   * 架空のレビューや指摘が製品の画面に出ないようにするための切り分け。
   */
  demo: boolean
  /** 起動時点の解決済みの配色。最初の描画の前に data-theme を決めるために使う */
  initialTheme: ResolvedTheme
  /** 起動時点の解決済みの画面の言語。最初の描画の文言を決めるために使う */
  initialLocale: SupportedLocale
}

/** contextBridge で公開するキー名 */
export const ADE_API_KEY = 'ade' as const

export const IPC_REQUEST_CHANNELS = [
  'app:ready',
  'app:settings',
  'app:version',
  'app:checkUpdate',
  'app:openUpdate',
  'resources:snapshot',
  'resources:kill',
  'resources:cleanup',
  'workspace:open',
  'workspace:current',
  'project:list',
  'project:add',
  'project:switch',
  'project:update',
  'project:remove',
  'settings:agents',
  'agents:list',
  'settings:agentPrompt',
  'accounts:list',
  'accounts:add',
  'accounts:rename',
  'accounts:remove',
  'accounts:select',
  'accounts:relogin',
  'usage:get',
  'usage:refresh',
  'usage:accounts',
  'mode:set',
  'browser:setBounds',
  'browser:navigate',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:setViewport',
  'browser:state',
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:close',
  'terminal:screen', 'terminal:agentState', 'terminal:cwd', 'review:send',
  'settings:splitRatio',
  'settings:layout',
  'settings:theme',
  'settings:locale',
  'settings:crashReports', 'telemetry:state', 'telemetry:noticeShown',
  'recording:start',
  'recording:pause',
  'recording:resume',
  'recording:stop',
  'recording:status',
  'annotation:setMode',
  'annotation:clear',
  'review:list', 'review:label', 'review:delete', 'review:load', 'review:edit', 'review:copy', 'review:folder', 'review:frames', 'review:organize', 'review:restore', 'capture:model', 'capture:apiKey', 'capture:devices', 'settings:capture', 'capture:availability', 'capture:testConnection', 'settings:stt', 'settings:organizer', 'organize:testConnection', 'capture:whisperModels', 'capture:downloadModel', 'capture:cancelModelDownload',
  'capture:sources', 'capture:setTarget', 'capture:openScreenSettings',
  'fs:list', 'fs:read', 'fs:write', 'fs:files', 'fs:search', 'editor:unsaved',
  'github:status', 'github:repo', 'github:reviewDraft', 'github:postReview', 'github:open'
] as const satisfies readonly IpcRequestChannel[]

export const IPC_EVENT_CHANNELS = [
  'browser:stateChanged',
  'mode:changed',
  'terminal:data',
  'terminal:exit',
  'menu:command',
  'workspace:changed',
  'projects:changed',
  'agents:changed',
  'recording:status',
  'recording:level',
  'recording:warning', 'capture:modelProgress', 'review:ready',
  'fs:changed',
  'theme:changed',
  'locale:changed',
  'usage:changed'
] as const satisfies readonly IpcEventChannel[]
