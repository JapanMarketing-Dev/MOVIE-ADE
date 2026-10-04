import type { AgentNotifyOpen, AgentNotifyRequest } from './agentNotify'
import type { FailoverLaunchRequest, FailoverNotice, LimitFailoverPrefs } from './failover'
import type { CliToolStatus } from './cliTools'
import type { AiEndpointConfig, AiVendor, LlmApiProvider, OrganizeRunnerId, SttRemoteProvider } from './aiProviders'
import type { AnnotationColor } from './annotation'
import type { AgentSkillAgent, AgentSkillStatus } from './agentSkill'
import type { SendRequest } from './sendTarget'
import type { CloneFailureKind, CloneProgress, GitHubRepoList, SshConfigHost } from './projectSource'
import type { SshTarget } from './sshCommand'
import type {
  AnnotationHistory,
  AnnotationShortcut,
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
  ProjectSession,
  ProjectUpdate,
  ProjectsState,
  TerminalCreateOptions,
  AudioLevel,
  BrowserState,
  MenuCommand,
  PlatformName,
  RecordingStatus,
  Settings,
  SettingsFileError,
  SettingsFileInfo,
  FeedbackTargetsPrefs,
  StartRecordingOptions,
  StartupTiming,
  TerminalSize,
  ThemePreference,
  TerminalTabInfo,
  AccountAgent,
  AgentOption,
  TerminalAttachInfo,
  ProgramCopyResult,
  TerminalClipboardMode,
  TerminalSessionInfo,
  ViewBounds,
  Viewport,
  WorkspaceState,
  TuiAgent
} from './types'
import type { DecisionPreferences } from './decision'
import type { ApiUsageSummary } from './apiUsage'
import type { ReviewData, ReviewEdit, ReviewLabelPatch, ReviewProgressPatch, ReviewSummary, ReviewFrame } from './review'
import type { ProgressMap, ReviewVerdict } from './findingProgress'
import type { AccountLoginRequest, AgentAccountAddResult, AgentAccountsState } from './accounts'
import type { AgentResourceList } from './agentResources'
import type { AccountUsage, UsageState } from './usage'
import type { UpdateCheckResult } from './appVersion'
import type { AutoUpdateStatus } from './appUpdate'
import type { SentryTestKind } from './telemetry'
import type { LayoutPrefs } from './layout'
import type { OnboardingPatch, OnboardingState, PermissionKind, PermissionsState } from './onboarding'
import type { ResolvedTheme } from './theme'
import type { LocalePreference, SupportedLocale } from './i18n'
import type { ResourceKillTarget, ResourceSnapshot } from './resources'
import type { FsChangedEvent, FsCreated, FsEntry, FsFileList, FsReadResult, FsSearchMode, FsSearchResult, FsTransfer, FsWriteResult } from './files'
import type { FsFileInfo } from './fileViewer'
import type { StarActionResult, StarPromptMode } from './starPrompt'
import type { FeedbackEnvironment, FeedbackSubmitInput, FeedbackSubmitResult } from './feedback'
import type { GitRepoStatus } from './github'
import type { DroppedEntry } from './externalDrop'

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
  /** settings.json の場所と、壊れているか（~/.ferret/settings.json。src/main/settingsFile.ts） */
  'settingsFile:info': () => SettingsFileInfo
  /** 生の settings.json（設定のページのエディタで開く） */
  'settingsFile:read': () => string
  /** エディタからの保存。壊れていれば書かずにエラーを返す。保存できたら null（取り込みは settings:changed で届く） */
  'settingsFile:write': (text: string) => SettingsFileError | null
  /** settings.json をファイルマネージャで見せる */
  'settingsFile:reveal': () => void
  /** フィードバックモードの右パネルの開閉と幅 */
  'settings:feedbackTargets': (prefs: FeedbackTargetsPrefs) => void
  /** package.json の version と、配布用にパッケージされた起動か（dev 起動なら false） */
  'app:version': () => { version: string; packaged: boolean }
  /** 配信元（R2）の latest.json と比べ、署名を確かめる。自動のダウンロードがオンなら、続けて裏でダウンロードを始める（src/main/autoUpdate.ts） */
  'app:checkUpdate': () => UpdateCheckResult
  /** 直前の確認で署名を確かめたインストーラーを、ダウンロードのフォルダに保存して見せる（自動更新ができないとき） */
  'app:openUpdate': () => void
  /** 裏での更新の状態（最後の確認の結果・ダウンロードの進み具合・「再起動して更新」ができるか） */
  'update:status': () => AutoUpdateStatus
  /** 新しい版を裏でダウンロードする（自動のダウンロードがオフのときの［ダウンロード］・失敗したときの［もう一度］） */
  'update:download': () => boolean
  /** 「再起動して更新」（deb はインストーラーを開く）。作業中の Agent・録画があれば確認を出し、やめたら false */
  'update:install': () => boolean
  /** 新しい版を自動でダウンロードするか（設定の autoUpdate） */
  'update:setAutoDownload': (on: boolean) => AutoUpdateStatus
  /** 設定の案内のリンク（キーを作るページなど）を外部のブラウザで開く。https だけ（src/shared/setupGuide.ts） */
  'app:openExternal': (url: string) => void
  /** 文を Agent のターミナルへ送る（Agent に設定を頼む指示文）。宛先は「Agent へ送信」と同じ選び方 */
  'agent:sendText': (text: string) => { ok: boolean; message: string; noAgent?: boolean }
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
  /** 名前・種類・確認先の変更。送った項目だけが変わる（Project をそのまま渡してもよい） */
  'project:update': (project: ProjectUpdate) => ProjectsState
  /** 登録を外すだけ。フォルダは消さない */
  'project:remove': (id: string) => ProjectsState
  /** 中央のタブ・開いているファイル・表示中のレビューを覚える（URL は main が自分で覚える）。通知は送らない */
  'project:saveSession': (id: string, session: Pick<ProjectSession, 'centerTab' | 'openFiles'> & { reviewId?: string | null }) => void
  /** 「プロジェクトを追加」の GitHub / SSH（src/main/projectSources.ts） */
  'project:sshHosts': () => SshConfigHost[]
  'project:githubRepos': () => GitHubRepoList
  /** 「GitLab から取得」の一覧（glab にログイン済みのホストごと。gitlab.com とセルフホスト） */
  'project:gitlabRepos': () => GitHubRepoList
  /** clone の保存先の親フォルダの既定 */
  'project:cloneDefaults': () => { parent: string; home: string }
  /** clone の保存先の親フォルダを選ぶ。キャンセルなら null */
  'project:pickParent': (current?: string) => string | null
  /** clone して、そのフォルダをプロジェクトとして開く。進み具合は project:cloneProgress */
  'project:clone': (url: string, parent: string) => { ok: true; state: ProjectsState } | { ok: false; kind: CloneFailureKind; detail: string }
  'project:cloneCancel': () => void
  /** SSH の接続先とリモートのフォルダを登録して開く（鍵やパスワードは扱わない） */
  'project:addSsh': (target: SshTarget, name?: string) => ProjectsState
  /** 外から落としたフォルダ（drop:inspect で確かめたもの）をプロジェクトとして登録して開く。登録済みならそれに切り替える */
  'project:addDropped': (path: string) => ProjectsState
  /** 一覧の並べ替え。ids は新しい並び（知らない ID は捨て、無いプロジェクトはその位置のまま） */
  'project:reorder': (ids: string[]) => ProjectsState
  /**
   * 外から落としたファイル・フォルダのパスを確かめる（src/main/droppedPaths.ts）。
   * preload の inspectDrop だけが呼ぶ（IPC_REQUEST_CHANNELS には入れない＝window.ade.invoke からは呼べない）
   */
  'drop:inspect': (paths: string[]) => DroppedEntry[]

  'settings:agents': (preferences: AgentPreferences) => void
  /** エージェントの一覧（設定とインストール済みかの検出を合わせたもの）。refresh で検出し直す */
  'agents:list': (refresh?: boolean) => AgentOption[]
  /** よく使うサービスの CLI（gh・wrangler・Ollama など）の検出（入っているか・版）。refresh で検出し直す */
  'cliTools:list': (refresh?: boolean) => CliToolStatus[]
  /** その CLI のスキル・スラッシュコマンド・MCP サーバー（読むだけ。MCP は名前・種類・コマンド名か host だけ） */
  'agents:resources': (agent: TuiAgent) => AgentResourceList
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
  /** 上限での自動切り替えの設定（保存はすぐ。設定画面のアカウントの節） */
  'failover:get': () => LimitFailoverPrefs
  'failover:set': (prefs: LimitFailoverPrefs) => LimitFailoverPrefs
  /** Agent が終わった・確認を待っている OS 通知（設定の agents.notify が入のときだけ main が出す）。出したら true */
  'agentNotify:show': (request: AgentNotifyRequest) => boolean

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
  'terminal:agentState': (id: string) => { kind: string; state: string; agent?: TuiAgent | null }
  /** シェルの今のカレント（分割したペインに引き継ぐ）。終了済みなら null */
  'terminal:cwd': (id: string) => string | null
  /** 開いているターミナルの一覧（画面を読み込み直したあと、つなぎ直す先を探す） */
  'terminal:list': () => TerminalSessionInfo[]
  /** 生きているターミナルにつなぎ直す（新しくは作らない）。終了していれば null */
  'terminal:attach': (id: string) => TerminalAttachInfo | null
  /** クリップボードの文字列（Windows / Linux のターミナルの Ctrl+V 貼り付け。renderer には読み取りの権限を渡していない） */
  'terminal:clipboardText': () => string
  /** ターミナルの選択範囲のコピーをクリップボードへ（キーを押した直後だけ書く。security-5 [9]） */
  'terminal:writeClipboard': (text: string) => void
  /** 端末のプログラムのコピー（OSC 52）。main が設定とフォーカスで決め、既定では預かって帯で確かめる（src/main/terminalClipboard.ts） */
  'terminal:programCopy': (id: string, text: string) => ProgramCopyResult
  /** 帯の［コピー］。預かったコピーを写す（利用者の操作の直後だけ）。写せたら true */
  'terminal:programCopyAccept': (id: string) => boolean
  /** 帯を閉じた。預かったコピーを捨てる */
  'terminal:programCopyDismiss': (id: string) => void
  /** 端末のプログラムのコピーの扱い（設定の terminalClipboard） */
  'settings:terminalClipboard': (mode: TerminalClipboardMode) => void
  /** ターミナルにフォーカスが入った・外れた。Windows / Linux でターミナルのキー（Ctrl+R など）をメニューに取らせない（terminalMenuKeys.ts） */
  'terminal:focused': (focused: boolean) => void
  /**
   * 指摘を Agent へ送る。request は宛先と差し替える本文（@shared/sendTarget の SendRequest。古い形のターミナルの id も受ける）。
   * noAgent: 宛先に Agent が居ない（launchAgent があればそれを、無ければ既定の Agent を renderer が起動して送り直す）。
   * terminalId: 実際に送ったターミナル。submitted: false なら貼り付けただけ（Enter は利用者が押す）
   */
  'review:send': (sessionId: string, request: SendRequest | string | null) => { ok: boolean; message: string; noAgent?: boolean; launchAgent?: TuiAgent; terminalId?: string; submitted?: boolean }

  'settings:splitRatio': (ratio: number) => void
  /** パネルの置き場所と表示、フッターの項目 */
  'settings:layout': (layout: LayoutPrefs) => void
  /** 配色を保存し、ネイティブ側（nativeTheme・ウインドウの背景）にも反映する */
  'settings:theme': (theme: ThemePreference) => void
  /** 画面の言語を保存し、main 側（メニュー・ダイアログ）も切り替える。戻り値は解決済みの言語 */
  'settings:locale': (locale: LocalePreference) => SupportedLocale
  /** クラッシュレポートを送るか。OFF はすぐ効く。ON は次の起動から（初期化は起動時だけ） */
  'settings:crashReports': (enabled: boolean) => void
  /** active = この起動で Sentry を初期化したか（設定が ON で E2E でないとき。dev も含む）。packaged = 配布版か。test = 確認用にわざと起こす例外（FERRET_SENTRY_TEST）。noticeShown = 初回の案内を出し終えたか */
  'telemetry:state': () => { active: boolean; enabled: boolean; noticeShown: boolean; packaged: boolean; test: SentryTestKind[] }
  /** 初回の案内を閉じた */
  'telemetry:noticeShown': () => void
  /** 初回起動のセットアップの進み具合を保存する（null で項目を消す）。保存後の値を返す */
  'settings:onboarding': (patch: OnboardingPatch) => OnboardingState | null
  /** Ferret の設定を変える skill（Claude Code・Codex）を入れてあるか */
  'agentSkill:status': () => AgentSkillStatus[]
  /** skill を入れる・書き直す（押した直後だけ）。agents を省くと使っている Agent すべて */
  'agentSkill:install': (agents?: AgentSkillAgent[]) => AgentSkillStatus[]
  /** マイク・画面収録の OS の許可の状態（読むだけで確認のダイアログは出さない） */
  'permissions:status': () => PermissionsState
  /** 押したときだけ許可を求める。マイクは OS の確認、画面収録はシステム設定を開く（macOS だけ） */
  'permissions:request': (kind: PermissionKind) => PermissionsState

  // 録画（要件 5.3・5.4）
  'recording:start': (options: StartRecordingOptions) => RecordingStatus
  'recording:pause': () => RecordingStatus
  'recording:resume': () => RecordingStatus
  'recording:stop': () => RecordingStatus
  'recording:status': () => RecordingStatus
  'annotation:setMode': (mode: AnnotationMode) => void
  /** 書き込みの色を変え、settings.json（capture.annotationColor）にも残す */
  'annotation:setColor': (color: AnnotationColor) => void
  'annotation:clear': () => void
  /**
   * 文字で指摘（エディタの内蔵ブラウザ・映したウインドウで枠を引いて指示を打つ。録画しない）の入・切。
   * reviewId は足し先（Findings で開いているレビュー）。無ければ最初の1件で新しいレビューを作る。実際の状態を返す
   */
  'note:setMode': (enabled: boolean, reviewId?: string | null) => boolean
  /** 書き込みを一つ前に戻す・やり直す（描く・動かす・消去が1手。録画中だけ） */
  'annotation:undo': () => void
  'annotation:redo': () => void
  /** 省略時は開いているフォルダ。指定できるのは登録済みプロジェクトのフォルダだけ（サイドバーの入れ子表示用） */
  'review:list': (folderPath?: string) => ReviewSummary[]
  /** セットアップの確認用。録画したことがあるか・送ったことがあるか（新しい数件だけを見る。全部の履歴は読まない） */
  'review:activity': (folderPath: string) => { recorded: boolean; sent: boolean }
  /** レビューの名前・アーカイブを変える（folderPath は登録済みプロジェクトに限る。省略時は開いているプロジェクト） */
  'review:label': (id: string, patch: ReviewLabelPatch, folderPath?: string) => void
  /** レビューを消す（.ferret/reviews/<日時>/ ごと。古いものは .ade-movie/）。消せた ID を返す */
  'review:delete': (ids: string[], folderPath?: string) => string[]
  'review:load': (id: string) => ReviewData
  'review:edit': (sessionId: string, edit: ReviewEdit) => ReviewData
  /** 指摘の進み具合（progress.json）を変えて、今の値を返す。patch を省くと読むだけ（Agent が書いたあとの読み直し） */
  'review:progress': (sessionId: string, patch?: ReviewProgressPatch) => ProgressMap
  /** 「Agent から確認があります」への返答を送る1行を作る。renderer が review:send の text（差し替えの本文）として送る */
  'review:replyPrompt': (sessionId: string, itemId: string, reply: string) => string
  /** 人の判断（OK / NG / Comment）を記録して、今の進み具合を返す。NG と Comment は本文が必須 */
  'review:verdict': (sessionId: string, itemId: string, verdict: ReviewVerdict, text?: string) => ProgressMap
  /** NG の指摘をコメントつきで送り直す1行を作る（itemIds を省くと送り直し待ちすべて）。renderer が review:send の text として送る */
  'review:ngPrompt': (sessionId: string, itemIds?: string[]) => { text: string; ids: string[] }
  /** NG を送り直したあと。送り直し待ちを外して対応中にする */
  'review:resent': (sessionId: string, itemIds: string[]) => ProgressMap
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
  /** 判定モデルの設定を保存し、整えた値を返す（キーは capture:apiKey で提供元ごとに保存） */
  'settings:decision': (prefs: DecisionPreferences) => DecisionPreferences
  /** 従量課金の API 呼び出しの集計（今日・今月・プロジェクト・モデル・種類ごと、直近 50 件）。フッター左下 */
  /** 判定モデルの「接続を確かめる」（押したときだけ。画面でまだ保存していない値で1回送る。記録に数える）。合否の判定はしない */
  'decision:testConnection': (prefs: DecisionPreferences) => { ok: boolean; message: string; model?: string; latencyMs?: number }
  'usage:apiCalls': () => ApiUsageSummary
  /** 記録の JSONL を Finder / エクスプローラーで示す */
  'usage:openApiLog': () => void
  'capture:model': () => boolean
  'capture:availability': () => SttAvailability
  /** 端末内の文字起こしのモデルの一覧と、whisper-cli の有無 */
  'capture:whisperModels': () => WhisperModelList
  /** 落として sha256 を照合し、終わったらそのモデルを選ぶ。失敗・中止は結果で返す */
  'capture:downloadModel': (id: WhisperModelName) => { ok: true } | { ok: false; reason: 'aborted' | 'failed'; message: string }
  'capture:cancelModelDownload': () => void
  /** 録画の対象の候補（画面・ウインドウ。サムネイル付き）と、画面収録の許可 */
  'capture:sources': () => CaptureSourceList
  /** 画面収録の許可だけを調べる（一覧は取らない。macOS で許可の確認ダイアログを出さないため） */
  'capture:screenAccess': () => CaptureSourceList['screenAccess']
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
  /** 文字として開けないファイルの大きさと先頭のバイト（画像・動画・バイナリの表示） */
  'fs:inspect': (relPath: string) => FsFileInfo
  /** ファイルツリーから空のファイル・フォルダを作る（名前の / で途中のフォルダも）。作ったものの相対パスを返す（既にあれば断る。src/main/fileOps.ts） */
  'fs:create': (parentRel: string, name: string, kind: 'file' | 'directory') => FsCreated
  /** 選んだものを destRel のフォルダへコピーする（貼り付け・複製。同じ名前は「名前 copy」にする） */
  'fs:copy': (relPaths: string[], destRel: string) => FsTransfer[]
  /** 選んだものを destRel のフォルダへ動かす（切り取り・貼り付け・ドラッグ。同じ名前があれば断る） */
  'fs:move': (relPaths: string[], destRel: string) => FsTransfer[]
  /** OS から落としたファイル・フォルダ（drop:inspect で確かめた絶対パスだけ）を destRel のフォルダへコピーする */
  'fs:import': (absolutePaths: string[], destRel: string) => FsTransfer[]
  /** OS から Markdown のファイルへ落とした画像・動画（drop:inspect で確かめた絶対パスだけ）を、その隣の assets/ などへコピーする。コピーの相対パスを渡した順に返す */
  'fs:importMedia': (markdownRel: string, absolutePaths: string[]) => string[]
  /** パスをクリップボードへ書く（絶対パスか、プロジェクトからの相対パス）。書いた文字列を返す */
  'fs:copyPath': (relPaths: string[], kind: 'absolute' | 'relative') => string
  /** 「ターミナルで開く」の作業フォルダ（絶対パス）。ファイルならその親 */
  'fs:terminalDir': (relPath: string) => string
  /** 同じフォルダの中で名前を変える。新しい相対パスを返す（既にある名前には上書きしない） */
  'fs:rename': (relPath: string, newName: string) => string
  /** ゴミ箱へ送る（shell.trashItem）。送った相対パスを返す */
  'fs:trash': (relPaths: string[]) => string[]
  /** Finder（エクスプローラ）でファイルを選んで見せる */
  'fs:reveal': (relPath: string) => void
  /** OS の既定のアプリで開く。実行されうる種類は断る（@shared/fileViewer の isRiskyToOpenExternally） */
  'fs:openExternal': (relPath: string) => void
  /** エディタで未保存のファイル（パス）。ウィンドウを閉じるときの確認に使う */
  'editor:unsaved': (paths: string[]) => void
  /** 編集中（未保存）の内容をプレビューの中身（HTML）にする。横に並べたプレビューを打鍵に追従させる */
  'preview:render': (path: string, source: string) => string

  // GitHub 連携（認証は gh CLI に任せる。トークンは扱わない）
  /** リポジトリ・ブランチ・フィードバックで作った Issue のページを既定のブラウザで開く（GitHub と今のプロジェクトのホストのURLだけ） */
  'github:open': (url: string) => void
  /** フッター用：今のプロジェクトのリポジトリ・ブランチ・変更の数。呼ぶと .git/HEAD の見張りも始める */
  'github:repoStatus': () => GitRepoStatus

  // GitHub の star のお願い（src/main/starPrompt.ts）。star するのは利用者が押したときだけ
  /** トーストの「Star」。gh で star できたら true（できなければ画面はブラウザの案内に切り替える） */
  'star:star': () => boolean
  /** リポジトリをブラウザで開く */
  'star:openWeb': () => void
  'star:later': () => void
  /** 「今後表示しない」 */
  'star:never': () => void
  /** 設定・ヘルプのいつでも押せる入口。gh で star、できなければブラウザで開く */
  'star:fromMenu': () => StarActionResult

  // フィードバック → GitHub の Issue（src/main/feedback.ts）。サーバーは使わない
  /** 環境情報（版・OS・CPU・言語）。パス・利用者名・プロジェクト名・URL・キーは伏せてある */
  'feedback:environment': () => FeedbackEnvironment
  /** gh でログイン中のアカウント名。未ログイン・gh 無しは null（ブラウザで開く案内にする） */
  'feedback:account': () => string | null
  /** 確認画面で見せた題名と本文のまま送る。gh で作るか、ブラウザで「新しい Issue」を開く */
  'feedback:submit': (input: FeedbackSubmitInput) => FeedbackSubmitResult
  /** Ferret の今の画面の静止画（PNG、2MB 以下に縮める）。フィードバックに添付する */
  'feedback:captureWindow': () => { type: 'image/png' | 'image/jpeg'; base64: string; width: number; height: number }
}

export interface IpcEvents {
  'browser:stateChanged': (state: BrowserState) => void
  'mode:changed': (mode: AppMode) => void
  'terminal:data': (id: string, data: string) => void
  'terminal:exit': (id: string, exitCode: number) => void
  'menu:command': (command: MenuCommand) => void
  'workspace:changed': (state: WorkspaceState) => void
  'projects:changed': (state: ProjectsState) => void
  'project:cloneProgress': (progress: CloneProgress) => void
  /** エージェントの設定が変わった（settings:agents の保存後） */
  'agents:changed': (options: AgentOption[]) => void
  'recording:status': (status: RecordingStatus) => void
  /** 録画の対象を main が変えた（ウインドウを映している間に URL を開いたので内蔵ブラウザへ戻した） */
  'capture:targetChanged': (target: CaptureTarget) => void
  'recording:level': (level: AudioLevel) => void
  /** 録画は続いているが、何かが取れなかった（マイク無しなど）ことを知らせる */
  'recording:warning': (message: string) => void
  /** 録画中の文字起こしの状態（右パネルの「文字起こし」タブと、止まったときの警告。@shared/liveTranscript） */
  'transcript:status': (status: import('./liveTranscript').LiveTranscriptStatus) => void
  /** 録画中に文字起こしできた発話（区切り1つ分） */
  'transcript:segments': (batch: import('./liveTranscript').LiveTranscriptBatch) => void
  /** 書き込みの「元に戻す／やり直す」ができるかが変わった */
  'annotation:history': (history: AnnotationHistory) => void
  /** ページに焦点があるときに押された、書き込みの道具の切り替えキー（ツールバーで処理する） */
  'annotation:shortcut': (action: AnnotationShortcut) => void
  'capture:modelProgress': (progress: WhisperModelProgress) => void
  /** API の呼び出しを記録したあとの集計（フッターの使用量を更新する） */
  'usage:apiCallsChanged': (summary: ApiUsageSummary) => void
  'review:ready': (review: ReviewData) => void
  /** 文字で指摘を足した（足した後のレビューと、その中の打った指摘の数）。画面はブラウザのまま */
  'note:added': (result: { review: ReviewData; count: number }) => void
  /** 文字で指摘の入・切を main が変えた（ページの Esc・録画の開始・プロジェクトの切り替え） */
  'note:mode': (active: boolean) => void
  /** 文字で指摘を足せなかった理由 */
  'note:error': (message: string) => void
  /** 開いているプロジェクトのレビューの progress.json（指摘の進み具合）が変わった。Agent の書き込みを画面へ反映する */
  'review:progressChanged': (ids: string[]) => void
  /** 使用量が変わった（取得中・成功・失敗） */
  'usage:changed': (state: UsageState) => void
  /** 上限での自動切り替え: このタブを開いて（開いたら main が引き継ぐ） */
  'failover:launch': (request: FailoverLaunchRequest) => void
  /** 上限での自動切り替え: 切り替えた・できなかった（フッターとトースト） */
  'failover:notice': (notice: FailoverNotice) => void
  /** Agent の通知が押された: そのプロジェクトへ切り替え、そのタブを開く */
  'agentNotify:open': (target: AgentNotifyOpen) => void
  /** プロジェクトの中のファイルが外部（Agent など）で変わった */
  'fs:changed': (event: FsChangedEvent) => void
  /** 解決済みの配色が変わった（設定の変更、または system のときの OS の切り替え） */
  'theme:changed': (theme: ResolvedTheme) => void
  /** 解決済みの画面の言語が変わった */
  'locale:changed': (locale: SupportedLocale) => void
  /** 開いているプロジェクトの .git/HEAD・index が変わった（ブランチの切り替え・コミット） */
  'github:headChanged': () => void
  /** star のお願いを出す（良い場面で、条件を満たしたときだけ） */
  'star:show': (mode: StarPromptMode) => void
  /** 使い始めてしばらくしたら一度だけ「使いづらいところはありましたか？」と聞く */
  'feedback:ask': () => void
  /** settings.json が外部（利用者のエディタ・Claude Code など）で書き換えられ、取り込んだ。平文のキーは外してある */
  'settings:changed': (settings: Settings) => void
  /** settings.json が壊れた（JSON・スキーマの誤り）。null は直った。壊れている間は取り込まず、ファイルも上書きしない */
  'settingsFile:error': (error: SettingsFileError | null) => void
  /** 裏での更新の状態が変わった（確認・ダウンロードの進み具合・準備ができた・失敗） */
  'update:status': (status: AutoUpdateStatus) => void
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
  /** OS の版（process.getSystemVersion()。Windows は 10.0.22631 の形で、ターミナルが ConPTY のビルド番号に使う） */
  systemVersion?: string
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
  /**
   * 外から落とした File の実パスを webUtils.getPathForFile で取り、main で確かめた結果を返す。
   * 存在しないもの・ファイルでもフォルダでもないものは入らない（src/shared/externalDrop.ts）
   */
  inspectDrop(files: readonly File[]): Promise<DroppedEntry[]>
}

/** contextBridge で公開するキー名 */
export const ADE_API_KEY = 'ade' as const

export const IPC_REQUEST_CHANNELS = [
  'app:ready',
  'app:settings',
  'settingsFile:info', 'settingsFile:read', 'settingsFile:write', 'settingsFile:reveal', 'settings:feedbackTargets',
  'app:version',
  'app:checkUpdate',
  'app:openUpdate', 'app:openExternal', 'agent:sendText',
  'update:status', 'update:download', 'update:install', 'update:setAutoDownload',
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
  'project:saveSession',
  'project:sshHosts',
  'project:githubRepos',
  'project:gitlabRepos',
  'project:cloneDefaults',
  'project:pickParent',
  'project:clone',
  'project:cloneCancel',
  'project:addSsh',
  'project:addDropped',
  'project:reorder',
  'settings:agents',
  'agents:list',
  'cliTools:list',
  'agents:resources',
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
  'failover:get', 'failover:set', 'agentNotify:show',
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
  'terminal:screen', 'terminal:agentState', 'terminal:cwd', 'terminal:list', 'terminal:attach', 'terminal:clipboardText', 'terminal:writeClipboard', 'terminal:programCopy', 'terminal:programCopyAccept', 'terminal:programCopyDismiss', 'settings:terminalClipboard', 'terminal:focused', 'review:send',
  'settings:splitRatio',
  'settings:layout',
  'settings:theme',
  'settings:locale',
  'settings:crashReports', 'telemetry:state', 'telemetry:noticeShown',
  'settings:onboarding', 'agentSkill:status', 'agentSkill:install', 'permissions:status', 'permissions:request',
  'recording:start',
  'recording:pause',
  'recording:resume',
  'recording:stop',
  'recording:status',
  'annotation:setMode',
  'annotation:setColor',
  'annotation:clear',
  'note:setMode',
  'annotation:undo',
  'annotation:redo',
  'review:list', 'review:activity', 'review:label', 'review:delete', 'review:load', 'review:edit', 'review:progress', 'review:replyPrompt', 'review:verdict', 'review:ngPrompt', 'review:resent', 'review:copy', 'review:folder', 'review:frames', 'review:organize', 'review:restore', 'capture:model', 'capture:apiKey', 'capture:devices', 'settings:capture', 'capture:availability', 'capture:testConnection', 'settings:stt', 'settings:organizer', 'organize:testConnection', 'settings:decision', 'decision:testConnection', 'usage:apiCalls', 'usage:openApiLog', 'capture:whisperModels', 'capture:downloadModel', 'capture:cancelModelDownload',
  'capture:screenAccess', 'capture:sources', 'capture:setTarget', 'capture:openScreenSettings',
  'fs:list', 'fs:read', 'fs:write', 'fs:files', 'fs:search', 'fs:inspect', 'fs:create', 'fs:copy', 'fs:move', 'fs:import', 'fs:importMedia', 'fs:copyPath', 'fs:terminalDir', 'fs:rename', 'fs:trash', 'fs:reveal', 'fs:openExternal', 'editor:unsaved', 'preview:render',
  'github:open', 'github:repoStatus',
  'star:star', 'star:openWeb', 'star:later', 'star:never', 'star:fromMenu',
  'feedback:environment', 'feedback:account', 'feedback:submit', 'feedback:captureWindow'
] as const satisfies readonly IpcRequestChannel[]

export const IPC_EVENT_CHANNELS = [
  'browser:stateChanged',
  'mode:changed',
  'terminal:data',
  'terminal:exit',
  'menu:command',
  'workspace:changed',
  'projects:changed',
  'project:cloneProgress',
  'agents:changed',
  'recording:status',
  'recording:level',
  'recording:warning', 'transcript:status', 'transcript:segments', 'capture:targetChanged', 'annotation:history', 'annotation:shortcut', 'capture:modelProgress', 'usage:apiCallsChanged', 'review:ready', 'review:progressChanged',
  'note:added', 'note:mode', 'note:error',
  'fs:changed',
  'theme:changed',
  'locale:changed',
  'usage:changed',
  'failover:launch', 'failover:notice', 'agentNotify:open',
  'github:headChanged',
  'star:show',
  'feedback:ask',
  'settings:changed', 'settingsFile:error',
  'update:status'
] as const satisfies readonly IpcEventChannel[]
