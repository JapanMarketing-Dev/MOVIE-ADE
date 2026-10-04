import { delay } from '@shared/delay'
import { shellQuote, sshShellSpec, type SshTarget } from '@shared/sshCommand'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import { type TerminalAttachInfo, type TerminalCreateOptions, type TerminalSessionInfo, type TerminalSize, type TerminalTabInfo, type TuiAgent } from '@shared/types'
import { buildAgentLaunchCommand, startupShellForPath } from '@shared/agentLaunch'
import { agentForProcess, agentLabel, findCustomAgent, isBuiltinAgent } from '@shared/agentCatalog'
import { resolveAgentLaunchPolicy } from '@shared/agentPolicy'
import { currentSettings } from './settings'
import { planStartupDelivery } from './shellStartup'
import { buildAccountLoginLaunch, resolveAgentEnv } from './accounts'
import { resolveProcessCwd } from './processCwd'
import { isInheritedAgentSessionEnv } from './inheritedAgentEnv'
import { remoteTrustedLaunchLine, resolveTrustedExecutable, trustedLaunchLine, windowsSearchPathEnv } from './agentExecutable'
import { executionSphere } from './executionSphere'
import { searchDirs } from './agentDetection'
import { TerminalHistory } from './terminalHistory'
import { defaultLocaleEnv, isHostTerminalEnv, stripAppImagePaths } from './terminalEnv'
import { windowsTreeKillCommand } from './platform/windowsTreeKill'
import { applyAgentWorkspaceTrust, registeredProjectIdFor } from './agentWorkspaceTrust'
import { detectState, parseTitle, stripAnsi } from './agent/state'
import type { AgentKind } from './agent/protocol'
import { ComposerReadiness } from './agent/readiness'
import { nextLaunchAgentPhase, type LaunchAgentPhase } from './agent/launchPhase'
import { sendToAgent } from './agent/send'
import { chooseSendTarget } from './agent/sendTarget'
import { agentSubmitsPaste } from '@shared/sendTarget'
import { agentInProcessTree, hasForegroundChild, isShellProcess, parseProcessRows, parseWindowsProcessRows, type ProcessRow } from './agent/processTree'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportMainError } from './telemetry'
import { flow, reportHandled, timedSync, errorKind } from '@shared/report'
import { exitWhenDoneCommand } from '@shared/agentInstall'
import { isKnownCliInstallCommand } from '@shared/cliTools'
import { DECISION_ENV_PREFIXES } from '@shared/decision'

/**
 * 終わったら閉じる1回きりのコマンド（Agent のインストール）。
 * 検証起動（ADE_E2E=1）では本物のインストーラを動かさない。ADE_E2E_INSTALL_COMMAND があればそれ
 * （例: echo installing && sleep 1 && exit 0）に差し替え、無ければ実行せずに表示だけして成功にする
 */
function oneShotCommand(command: string): string {
  if (process.env.ADE_E2E !== '1') return command.trim()
  const mock = process.env.ADE_E2E_INSTALL_COMMAND?.trim()
  return mock || `echo ${shellQuote(`[E2E] ${command.trim()}`)}`
}

/**
 * 内蔵ターミナル（WS-4）。node-pty のPTYをメインプロセスで持ち、
 * renderer の xterm.js とは IPC でつなぐ。
 *
 * NF-6（大量出力中も入力が詰まらない）のため、PTY出力はそのまま転送せず、
 * 1フレーム分ためてから1回のIPCで送る。
 */

/** PTY出力をまとめる間隔。xterm.js 側の描画が1フレームに1回で足りる */
const FLUSH_INTERVAL_MS = 16
/** 1回のフラッシュで送る上限。超えた分は次のフラッシュへ回す */
const MAX_CHUNK = 256 * 1024
/** ためこみの上限。これを超えたら古い側を捨てて入力の応答を守る */
const MAX_BUFFER = 4 * 1024 * 1024
/** 起動ファイルにフックを差し込めないシェルで、出力が止まってから起動コマンドを書き込むまでの間 */
const STARTUP_WRITE_QUIET_MS = 300
/** 出力が止まらなくても、ここまで待ったら書き込む */
const STARTUP_WRITE_TIMEOUT_MS = 5000

export interface ShellSpec {
  file: string
  args: string[]
}

/**
 * ユーザーのログインシェルを決める。3つのOSで動く書き方にする。
 * - Windows: COMSPEC（cmd.exe）。ログインシェルの概念がないので引数なし
 * - macOS / Linux: $SHELL をログインシェル（-l）として起動し、
 *   .zprofile / .bash_profile で入るPATH（nvm、Homebrew など）を反映させる
 */
function resolveShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform === 'win32') {
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: [] }
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : fallback
  return { file: shell, args: ['-l'] }
}

/** PTYに渡す環境変数。Electron固有の変数は子プロセスへ漏らさない */
function ptyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(key)) continue
    // 親の Claude Code / Codex のセッションの印は渡さない（新しいターミナルは親のエージェントの子ではない）
    if (isInheritedAgentSessionEnv(key, value)) continue
    // 別の Ferret（親）の判定モデルの中継の URL は古い合言葉なので受け継がない（旧名も）。このアプリの値は extra で渡す
    if (DECISION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    // Ferret を起動した端末・AppImage・Crashpad・開発起動の変数は渡さない（terminalEnv.ts）
    if (isHostTerminalEnv(key)) continue
    env[key] = value
  }
  if (process.platform === 'linux') stripAppImagePaths(env, process.env.APPDIR)
  Object.assign(env, defaultLocaleEnv(env, process.platform))
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Windows の cmd.exe に、素の名前を今のフォルダ（プロジェクト）から探させない（security-4 [1]）
  return { ...env, ...extra, ...windowsSearchPathEnv() }
}

/**
 * node-pty はネイティブモジュールなので、最初のタブを開くまで読み込まない（起動時間 NF-5）。
 * Electron のバージョンに対して正しくビルドされていない場合は、ここで原因が分かるようにする。
 */
let nodePtyPromise: Promise<typeof import('node-pty')> | null = null

async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) {
    nodePtyPromise = import('node-pty').catch((err: unknown) => {
      nodePtyPromise = null
      throw new Error(
        t('terminal.errors.nodePty'),
        { cause: err }
      )
    })
  }
  return nodePtyPromise
}

/**
 * ps の結果。送信先を選ぶときは全タブを続けて調べるので、1秒だけ使い回す（タブの数だけ ps を起動しない）
 */
let processCache: { at: number; rows: Promise<ProcessRow[]> } | null = null
function processRows(): Promise<ProcessRow[]> {
  if (!processCache || Date.now() - processCache.at > 1000) {
    const rows = promisify(execFile)('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }).then(({ stdout }) => parseProcessRows(stdout))
    processCache = { at: Date.now(), rows }
    rows.catch(() => { processCache = null }) // 失敗は使い回さない（呼び出し側が受け取る）
  }
  return processCache.rows
}

/**
 * Windows のプロセス一覧（ps が無いので PowerShell の Win32_Process）。PowerShell の起動は重く、
 * ARM64 のエミュレーションでは数秒かかるので、前の結果をすぐ返しつつ裏で取り直す（5秒に1回まで。
 * 起動のたびに CPU を使い、マウスの砂時計も点滅させるため間を空ける。Orca #10857 #12288）
 */
const WINDOWS_PROCESS_QUERY =
  "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | " +
  'ForEach-Object { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine)) }'
let windowsProcessCache: { at: number; rows: ProcessRow[] | null; pending: Promise<ProcessRow[]> | null } = { at: 0, rows: null, pending: null }
function windowsProcessRows(): Promise<ProcessRow[]> {
  const cache = windowsProcessCache
  if (!cache.pending && Date.now() - cache.at > 5000) {
    cache.pending = promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true })
      .then(({ stdout }) => {
        const rows = parseWindowsProcessRows(stdout)
        windowsProcessCache = { at: Date.now(), rows, pending: null }
        return rows
      }, (err: unknown) => {
        windowsProcessCache = { at: Date.now(), rows: cache.rows, pending: null }
        throw err
      })
    cache.pending.catch(() => undefined) // 前の結果を返すときは、ここでの失敗を誰も受け取らない
  }
  if (cache.rows) return Promise.resolve(cache.rows)
  return cache.pending ?? Promise.reject(new Error('process list unavailable'))
}

interface Session {
  id: string
  pty: IPty
  buffer: string[]
  bufferBytes: number
  timer: NodeJS.Timeout | null
  tail: string
  screen?: { text: string; at: number }
  title?: string
  readiness: ComposerReadiness
  sending: boolean
  /** 開いたときの情報（Resource Manager などの一覧用） */
  info: TerminalSessionInfo
  /** 直近の出力。画面を読み込み直したあと、つなぎ直したタブに流し直す */
  history: TerminalHistory
  /** 起動時の Agent の推定の段階（agent/launchPhase.ts） */
  launchAgent?: LaunchAgentPhase
}

export type { TerminalSessionInfo } from '@shared/types'

export class TerminalManager {
  private sessions = new Map<string, Session>()
  /**
   * kill は済んだが、まだ onExit が届いていないPTY。
   * 強制終了に切り替えるときのために、PTYと（kill前に調べた）子孫PIDを持つ。
   */
  private awaitingExit = new Map<string, { pty: IPty; descendants: number[] }>()
  /** 「全部の終了通知が届いた」を待っている人たち */
  private exitWaiters = new Set<() => void>()
  private seq = 0
  private cwd: string = homedir()
  /** SSH のプロジェクトを開いているときの接続先。タブは ssh -t でリモートのシェルとして開く（src/shared/sshCommand.ts） */
  private remote: SshTarget | null = null

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number) => void
  ) {}

  /**
   * タブを開くたびに足す環境変数（判定モデルの中継の URL など。src/main/decision/service.ts）。
   * キーのような秘密はここで渡さないこと
   */
  launchEnv: ((meta: { agent: string | null; sessionId: string }) => Promise<Record<string, string>>) | null = null

  /**
   * タブ（PTY）が終わったら呼ぶ。launchEnv で渡した合言葉など、そのタブに結び付けたものを無効にする。
   * 起動に失敗したときも呼ぶ
   */
  onSessionClosed: ((sessionId: string) => void) | null = null

  /**
   * 上限での自動切り替え（src/main/failover/service.ts）。入力・出力・送った指示と、開いた Agent のタブを渡す
   */
  failover: {
    input(id: string, data: string): void
    output(id: string, text: string): void
    sent(id: string, text: string): void
    launched(id: string, agent: TuiAgent, token: string | null): void
    closed(id: string): void
  } | null = null

  /**
   * 後始末が残っているPTYの数。
   * 生きているものと、kill 済みで終了通知待ちのものの両方を数える。
   */
  pendingCount(): number {
    return this.sessions.size + this.awaitingExit.size
  }

  /** 開いたプロジェクトフォルダを、以降に作るタブのカレントにする */
  setCwd(dir: string | null): void {
    this.cwd = dir ?? homedir()
  }

  /** SSH のプロジェクトのときだけ渡す。null ならローカルのシェル */
  setRemote(target: SshTarget | null): void {
    this.remote = target
  }

  /**
   * タブを1つ開く。cwd を省略すると開いているプロジェクトのフォルダ。
   * agent を指定すると、ログインシェルが立ち上がった最初のプロンプトでそのAgentを起動する
   * （Agentを終了するとシェルに戻る。Orcaと同じ）。
   */
  async create(options: TerminalCreateOptions): Promise<TerminalTabInfo> {
    const { size, agent } = options
    const nodePty = await loadNodePty()
    // アカウントのログインは、プロジェクトではないフォルダで動かす（プロジェクトに置かれた同じ名前のコマンドを拾わない。security-4 [1]）
    const cwd = options.accountLogin ? homedir() : options.cwd && existsSync(options.cwd) ? options.cwd : this.cwd
    // SSH のプロジェクト：ssh -t -- <host> 'cd <path> && exec "$SHELL" -l'。Agent の起動はリモートの最初のプロンプトで打ち込む。
    // アカウントのログインは SSH のプロジェクトでも手元で動かす（security-5 [3]）
    const sphere = executionSphere({ accountLogin: Boolean(options.accountLogin), remote: this.remote })
    let shell = sphere.kind === 'ssh' ? sshShellSpec(sphere.target) : resolveShell()
    const startupShell = startupShellForPath(shell.file)
    let extraEnv: Record<string, string> = {}
    let pendingWrite: string | null = null
    let loginTitle: string | null = null
    // 起動コマンドを、シェルの最初のプロンプトで実行させる（Agent・アカウントのログイン共通）
    const deliver = (command: string, env: Record<string, string>): void => {
      const delivery = planStartupDelivery(shell, command)
      shell = delivery.shell
      // 選んだアカウントの設定フォルダ（CLAUDE_CONFIG_DIR / CODEX_HOME）。起動の仕組みの変数を優先する
      extraEnv = { ...env, ...delivery.env }
      if (delivery.kind === 'write') pendingWrite = command
    }
    // 組み込みの Agent とログインは、決まりを通した argv の実行ファイルを信頼できる絶対パスにして起動する。
    // 見つからなければ起動しない（security-4 [1]・security-5 [5]）。リモートでは、リモートのシェルで同じ決まりで探す
    const trusted = async (argv: readonly string[], label: string): Promise<string> => {
      if (sphere.kind === 'ssh') return remoteTrustedLaunchLine(argv)
      const resolved = await resolveTrustedExecutable(argv[0] ?? '', { env: ptyEnv(), cwd, dirs: process.platform === 'win32' ? undefined : await searchDirs() })
      if (!resolved.ok) throw new UserFacingError(t('terminal.errors.launch', { agent: label, error: t('settings.agents.notFound') }))
      return trustedLaunchLine(resolved.path, argv.slice(1), startupShell)
    }
    if (options.accountLogin) {
      const login = buildAccountLoginLaunch(options.accountLogin, startupShell)
      loginTitle = login.title
      deliver(await trusted(login.argv, login.title), login.env)
    } else if (agent) {
      const settings = currentSettings()
      const prefs = settings.agents
      // 組み込みは launch の設定、カスタムは登録した command / args
      const configured = isBuiltinAgent(agent) ? prefs.launch[agent] : findCustomAgent(prefs, agent)
      if (!configured) throw new UserFacingError(t('terminal.errors.unknownAgent', { agent: agentLabel(agent, prefs) }))
      // 権限確認を省くか・フォルダの信頼を書くかは、ここ（main）で決める（設定の skipPermissions）。
      // 組み込みは設定を一度だけ argv に分けてから決まりを当て、決まりを通した argv だけで起動する（security-5 [2]）
      const projectId = registeredProjectIdFor(cwd, settings.projects)
      const label = agentLabel(agent, prefs)
      let launchLine: string
      let trustFolder = false
      if (isBuiltinAgent(agent)) {
        const policy = resolveAgentLaunchPolicy({ agent, command: configured.command, args: configured.args, projectId, skipPermissions: prefs.skipPermissions, shell: startupShell })
        if (!policy.ok) throw new UserFacingError(t('terminal.errors.launch', { agent: label, error: policy.error }))
        trustFolder = policy.trustFolder
        launchLine = await trusted(policy.argv, label)
      } else {
        // カスタムの Agent は利用者が書いたコマンドそのまま（引数だけ語に分けて引用し直す）
        const custom = buildAgentLaunchCommand(agent, configured, startupShell)
        if (!custom.ok) throw new UserFacingError(t('terminal.errors.launch', { agent: label, error: custom.error }))
        launchLine = custom.command
      }
      // パンくず：自作の Agent は名前を出さない（利用者が付けた名前を送らない）
      flow('agent launch', { agent: isBuiltinAgent(agent) ? agent : 'custom' })
      const accountEnv = resolveAgentEnv(agent)
      // 権限確認を省いて起動するときは、登録したプロジェクトのフォルダについて Claude Code / Codex の「このフォルダを信頼しますか」も先に書いておく
      // （書く先はアカウント切り替えの CLAUDE_CONFIG_DIR / CODEX_HOME を含む、起動する環境のもの）。
      // 切にしていれば書かず、エージェント自身にフォルダのパスを見せて聞かせる
      if (trustFolder) {
        await applyAgentWorkspaceTrust({
          agent,
          cwd,
          projectFolders: settings.projects.map((project) => project.folderPath),
          env: ptyEnv(accountEnv)
        })
      }
      deliver(launchLine, accountEnv)
    } else if (options.command?.trim()) {
      // CLI のインストール（設定の「CLI」の一覧から）は E2E では本物を走らせない（oneShotCommand が差し替える）
      const line = options.exitWhenDone || isKnownCliInstallCommand(options.command) ? oneShotCommand(options.command) : options.command.trim()
      deliver(options.exitWhenDone ? exitWhenDoneCommand(line, shell.file) : line, {})
    }
    const id = `t${++this.seq}`
    // 判定モデルの中継の URL など（このタブに結び付ける）。用意できなくてもタブは開く（指示文の受け入れ確認が使えないだけ）
    const launchEnv = this.launchEnv ? await this.launchEnv({ agent: agent ? agentLabel(agent, currentSettings().agents) : null, sessionId: id }).catch((err: unknown) => {
      reportHandled(err, { area: 'terminal', op: 'prepare decision env' })
      return {}
    }) : {}
    let pty: ReturnType<typeof nodePty.spawn>
    try {
      pty = nodePty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(2, size.cols),
        rows: Math.max(1, size.rows),
        cwd,
        env: ptyEnv({ ...launchEnv, ...extraEnv })
      })
    } catch (err) {
      // シェルの名前だけを付ける（パスは送る前に落とす。src/main/telemetry.ts）
      reportMainError(err, { kind: 'pty-spawn', shell: shellLabel(shell.file) })
      this.onSessionClosed?.(id)
      throw err
    }
    const title =
      loginTitle ??
      (options.title?.trim() || (agent ? agentLabel(agent, currentSettings().agents) : `${this.seq}: ${shellLabel(shell.file)}`))
    const launched = options.accountLogin?.agent ?? agent ?? null
    const session: Session = { id, pty, buffer: [], bufferBytes: 0, timer: null,
      tail: '', readiness: new ComposerReadiness(), sending: false,
      info: { id, pid: pty.pid, cwd, title, agent: launched }, history: new TerminalHistory() }
    this.sessions.set(id, session)
    if (agent) this.failover?.launched(id, agent, options.failoverToken ?? null)

    const stopStartupWrite = pendingWrite ? this.scheduleStartupWrite(session, pendingWrite) : null
    pty.onData((data) => {
      stopStartupWrite?.touch()
      this.enqueue(session, data)
    })
    flow('terminal create', { kind: launched ? 'agent' : 'shell' })
    pty.onExit(({ exitCode }) => {
      // パンくず：Agent の異常終了（exit code≠0）が、このあとの失敗の手がかりになる
      flow('terminal exit', { exitCode, kind: launched ? (isBuiltinAgent(launched) ? launched : 'custom') : 'shell' })
      stopStartupWrite?.cancel()
      this.flush(session)
      this.sessions.delete(id)
      this.awaitingExit.delete(id)
      this.onSessionClosed?.(id)
      this.failover?.closed(id)
      this.onExit(id, exitCode)
      this.notifyExitWaiters()
    })

    return { id, title, agent: launched, cwd }
  }

  /**
   * シェルの今のカレント（分割したペインに引き継ぐ）。シェルの中で cd していればその場所。
   * 調べられなければ開いたときのカレント
   */
  async currentCwd(id: string): Promise<string | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    return (await resolveProcessCwd(session.pty.pid)) || session.info.cwd
  }

  /** 開いているターミナルの一覧（読み取り専用。CPU・メモリの集計は呼び出し側が pid で行う） */
  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }))
  }

  /**
   * 画面を読み込み直したあと、生きているターミナルにつなぎ直す。新しくは作らず、直近の出力を返す。
   * 送りかけの出力は先に流して、履歴と画面への転送が重ならないようにする。終了していれば null
   */
  attach(id: string): TerminalAttachInfo | null {
    const session = this.sessions.get(id)
    if (!session) return null
    this.flush(session)
    return { ...session.info, history: session.history.snapshot(), size: { cols: session.pty.cols, rows: session.pty.rows } }
  }

  /**
   * フックを差し込めないシェル向け。最初の出力のあと出力が止まったら（＝プロンプトが出たら）
   * 起動コマンドを打ち込む。Orca が準備完了を待てないときに待ち時間で書き込むのと同じ考え方。
   */
  private scheduleStartupWrite(session: Session, command: string): { touch: () => void; cancel: () => void } {
    let done = false
    let quietTimer: NodeJS.Timeout | null = null
    const fire = (): void => {
      if (done) return
      done = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(deadline)
      if (this.sessions.get(session.id) === session) session.pty.write(`${command}\r`)
    }
    const deadline = setTimeout(fire, STARTUP_WRITE_TIMEOUT_MS)
    return {
      touch: () => {
        if (done) return
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(fire, STARTUP_WRITE_QUIET_MS)
      },
      cancel: () => {
        done = true
        if (quietTimer) clearTimeout(quietTimer)
        clearTimeout(deadline)
      }
    }
  }

  private enqueue(session: Session, data: string): void {
    session.history.push(data)
    this.failover?.output(session.id, stripAnsi(data))
    session.tail = (session.tail + stripAnsi(data)).slice(-8000)
    session.title = parseTitle(data) ?? session.title
    session.readiness.push(data)
    session.buffer.push(data)
    session.bufferBytes += data.length
    while (session.bufferBytes > MAX_BUFFER && session.buffer.length > 1) {
      const dropped = session.buffer.shift()
      session.bufferBytes -= dropped?.length ?? 0
    }
    if (session.timer) return
    session.timer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS)
  }

  private flush(session: Session): void {
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    if (session.buffer.length === 0) return
    let payload = session.buffer.join('')
    session.buffer = []
    session.bufferBytes = 0
    if (payload.length > MAX_CHUNK) {
      const rest = payload.slice(MAX_CHUNK)
      payload = payload.slice(0, MAX_CHUNK)
      session.buffer.push(rest)
      session.bufferBytes = rest.length
      session.timer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS)
    }
    this.onData(session.id, payload)
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.failover?.input(id, data)
    session.pty.write(data)
  }

  /** 画面の末尾のテキスト（renderer が送った表示、無ければ出力の末尾）。上限の確かめと引き継ぎの指示文に使う */
  screenText(id: string): string {
    const session = this.sessions.get(id)
    return session ? (session.screen?.text ?? session.tail) : ''
  }

  updateScreen(id: string, text: string): void {
    const session = this.sessions.get(id)
    if (session && session.screen?.text !== text.slice(-10000)) session.screen = { text: text.slice(-10000), at: Date.now() }
  }

  async agentState(id: string): Promise<{ kind: AgentKind; state: string; agent: TuiAgent | null }> {
    const session = this.sessions.get(id)
    if (!session) return { kind: 'unknown', state: 'unknown', agent: null }
    const prefs = currentSettings().agents
    // PTY が終わったあとは process が undefined になる（node-pty。前面には何も居ない扱い）
    const command = session.pty.process ?? ''
    const windows = process.platform === 'win32'
    // node-pty の Windows 版の process は端末名（xterm-256color）で、前面のプロセスを表さない
    let agent = windows ? null : agentForProcess(command, prefs)
    // 名前で決まらないとき（npm 版は node、公式インストーラの Claude Code は版番号、ラッパーのスクリプトなど）は、
    // シェルの子から1段ずつコマンド行を見て同定する（agent/processTree.ts）。シェルに戻っていれば何も居ない
    let foreground = !isShellProcess(command)
    if (windows) {
      // Windows はシェルの子を見る。一覧が取れなければ、起動時の Agent で判断する（下）
      const rows = await windowsProcessRows().catch(() => null)
      if (rows) {
        foreground = hasForegroundChild(rows, session.pty.pid)
        if (foreground) agent = agentInProcessTree(rows, session.pty.pid, (line) => agentForProcess(line, prefs))
      }
    }
    if (!agent && foreground && process.platform !== 'win32') {
      try {
        agent = agentInProcessTree(await processRows(), session.pty.pid, (line) => agentForProcess(line, prefs))
      } catch { /* ps が使えなければ下の起動時の Agent で判断する */ }
    }
    // Agent として開いたタブで、シェルではない何かが前面で動いていれば、その Agent とみなす
    // （独自のラッパーや、名前を変えて動く版でも送れるように。シェルに戻っていれば送らない）。
    // いちど Agent が終わってシェルに戻ったら、以後はこの推定をしない（agent/launchPhase.ts。Orca #6355）
    if (session.info.agent) session.launchAgent = nextLaunchAgentPhase(session.launchAgent, foreground)
    if (!agent && foreground && session.info.agent && session.launchAgent !== 'ended') agent = session.info.agent
    const kind: AgentKind = agent === 'claude' ? 'claude-code' : agent === 'codex' ? 'codex' : agent ? 'generic' : 'unknown'
    return { kind, agent, state: kind === 'unknown' ? 'unknown' : detectState(kind, { title: session.title, tail: session.screen?.text ?? session.tail }) }
  }

  /** その Agent が動いている、同じプロジェクトのターミナル（待機中を先に）。無ければ null */
  async findAgentTerminal(agent: TuiAgent, projectDir: string | null): Promise<string | null> {
    const candidates = await Promise.all([...this.sessions.values()].map(async (session) => ({
      id: session.id, cwd: session.info.cwd, ...(await this.agentState(session.id))
    })))
    return chooseSendTarget(null, candidates.filter((c) => c.agent === agent), projectDir)
  }

  /**
   * 「Agentへ送信」の宛先。選んでいるターミナルに Agent が居なければ、同じプロジェクトの Agent のターミナル。
   * どこにも居なければ null（agent/sendTarget.ts）
   */
  async resolveSendTarget(preferred: string | null, projectDir: string | null): Promise<string | null> {
    const candidates = await Promise.all([...this.sessions.values()].map(async (session) => ({
      id: session.id, cwd: session.info.cwd, ...(await this.agentState(session.id))
    })))
    return chooseSendTarget(preferred, candidates, projectDir)
  }

  async sendReview(id: string, text: string): Promise<{ ok: boolean; message: string; submitted?: boolean }> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, message: t('terminal.send.openTerminal') }
    if (session.sending) return { ok: false, message: t('terminal.send.busy') }
    const { kind, agent } = await this.agentState(id)
    if (kind === 'unknown') return { ok: false, message: t('terminal.send.noAgent') }
    // Enter で送信されると確かめていない Agent は、貼り付けるだけにする（@shared/sendTarget）
    const submit = agentSubmitsPaste(agent)
    // Claude Code / Codex 以外は待機中の見え方を知らないので、確認待ちでなく、出力が落ち着いていれば送る
    // （Orca が個別の合図を持たないエージェントに使う quiet-render と同じ考え方）。結果は「確かめられない」と伝える
    const generic = kind === 'generic'
    const deadline = Date.now() + 5000
    while (session.readiness.status() !== 'ready') {
      const state = await this.agentState(id)
      if (state.state === 'blocked') return { ok: false, message: t('terminal.send.blocked') }
      const quiet = session.screen && Date.now() - session.screen.at >= 1500
      if (quiet && (state.state === 'idle' || (generic && state.state === 'unknown'))) break
      if (Date.now() >= deadline) return { ok: false, message: t('terminal.send.notReady') }
      await delay(100)
    }
    session.sending = true
    try {
      const result = await sendToAgent({ text, submit,
        terminal: { write: (data) => { if (!this.sessions.has(id)) throw new UserFacingError(t('terminal.send.exited')); session.pty.write(data) }, onData: () => () => {} },
        getState: async () => {
          const state = (await this.agentState(id)).state
          if (state === 'blocked' || state === 'idle' || state === 'working') return state
          return generic ? 'idle' : 'unknown'
        } })
      if (result.ok) this.failover?.sent(id, text)
      if (result.ok && !result.submitted) return { ok: true, submitted: false, message: t('terminal.send.pastedNoEnter', { agent: agentLabel(agent, currentSettings().agents) }) }
      return { ok: result.ok, submitted: result.ok, message: result.ok ? t(generic ? 'terminal.send.doneUnverified' : 'terminal.send.done') : result.message }
    } finally { session.sending = false }
  }

  resize(id: string, size: TerminalSize): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.pty.resize(Math.max(2, size.cols), Math.max(1, size.rows))
    } catch (err) {
      // ウィンドウ縮小の途中で不正な値になることがある。無視して次のリサイズを待つ
      console.warn(`[terminal] resize 失敗 ${id}`, err)
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.flush(session)
    this.sessions.delete(id)
    // 閉じた時点で、このタブに渡した合言葉などを無効にする（SIGHUP を無視するシェルや残った子プロセスに使わせない）
    this.onSessionClosed?.(id)
    this.failover?.closed(id)
    // kill してから onExit が届くまでを「後始末中」として数える。
    // 子孫PIDは、シェルが死んで辿れなくなる前のものを控えておく。
    const descendants = killPtyTree(session.pty, 'SIGHUP')
    this.awaitingExit.set(id, { pty: session.pty, descendants })
  }

  private notifyExitWaiters(): void {
    if (this.awaitingExit.size > 0) return
    for (const waiter of [...this.exitWaiters]) waiter()
  }

  /**
   * すべてのPTYを終了する（終了通知は待たない）。
   *
   * アプリ終了の直前ではなく、できるだけ早い段階で呼ぶこと。
   * node-pty は exit を ThreadSafeFunction でJSへ返すため、Nodeの環境クリーンアップ
   * （`Environment::RunCleanup`）に重なると napi 呼び出しに失敗し、
   * 例外が外へ投げられてプロセスが abort する（SIGABRT）。
   */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /**
   * すべてのPTYを終了し、**各PTYの onExit が届くまで待つ**。
   *
   * ここで待たずに Node の環境解体へ進むと、node-pty の ThreadSafeFunction が
   * 解体中に発火して abort する（SIGABRT）。
   *
   * 既定の kill は SIGHUP で、`trap '' HUP` のように無視するシェルでは終了しない。
   * そこで `escalateAfterMs` で SIGKILL に切り替え、それでも届かない場合は
   * `timeoutMs` で打ち切る（打ち切りの扱いは呼び出し側が決める）。
   */
  disposeAllAndWait(
    options: { escalateAfterMs?: number; timeoutMs?: number } = {}
  ): Promise<{ clean: boolean; pending: number; waitedMs: number }> {
    const escalateAfterMs = options.escalateAfterMs ?? 500
    const timeoutMs = options.timeoutMs ?? 2000
    const startedAt = Date.now()

    this.disposeAll()
    if (this.awaitingExit.size === 0) {
      return Promise.resolve({ clean: true, pending: 0, waitedMs: 0 })
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (clean: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(escalateTimer)
        clearTimeout(giveUpTimer)
        this.exitWaiters.delete(waiter)
        resolve({
          clean,
          pending: this.awaitingExit.size,
          waitedMs: Date.now() - startedAt
        })
      }
      const waiter = (): void => finish(true)

      // SIGHUP を無視するシェルが残っていたら、強制終了に切り替える
      const escalateTimer = setTimeout(() => {
        for (const entry of this.awaitingExit.values()) {
          killPtyTree(entry.pty, 'SIGKILL', entry.descendants)
        }
      }, escalateAfterMs)
      escalateTimer.unref?.()

      const giveUpTimer = setTimeout(() => finish(false), timeoutMs)
      giveUpTimer.unref?.()

      this.exitWaiters.add(waiter)
    })
  }
}

/**
 * あるプロセスの子孫のPIDを列挙する（POSIX）。
 *
 * シェルを落とすと子プロセスの親は init に付け替えられ、辿れなくなる。
 * そのため kill の**前**に呼び、結果を控えておく。
 */
function descendantPids(root: number): number[] {
  let listing: string
  try {
    // 同期の ps（main が止まる）。重ければ手がかりとして控える
    listing = timedSync('ps', () => execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 }))
  } catch (err) {
    // 子プロセスを数えられないだけで、終了処理は pty.kill で続ける
    // 失敗の文は ps の stderr を含むので、種類だけを送る
    reportHandled(errorKind(err), { area: 'terminal', op: 'list child processes' })
    return []
  }

  const children = new Map<number, number[]>()
  for (const line of listing.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!matched) continue
    const pid = Number(matched[1])
    const ppid = Number(matched[2])
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }

  const found: number[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as number
    for (const child of children.get(current) ?? []) {
      // 念のため自分自身とinitは触らない
      if (child <= 1 || child === process.pid) continue
      found.push(child)
      stack.push(child)
    }
  }
  return found
}

/**
 * PTYにぶら下がるプロセスを、シェルだけでなくまとめて終了させる。
 *
 * `pty.kill()` はシェル本体にしかシグナルを送らない。対話シェルはジョブ制御で
 * 実行中のコマンド（`sleep`、起動中のAgent など）を**別のプロセスグループ**に置くため、
 * シェルを落としてもそれらは孤児として残る。ユーザーから見れば「アプリを終了したのに
 * Agentが動き続けている」状態になり、PTYのスレーブ側も掴まれたままになる。
 *
 * そこで、シェルの子孫を先に落としてから、シェル自身のプロセスグループを落とす。
 * Windows には同じ概念が無い。node-pty の `kill()` はコンソールに付いたものしか畳まないので、
 * 先に taskkill /T でシェルの子孫ごと終わらせてから `kill()` する（windowsTreeKill.ts）。
 *
 * @param known 以前に列挙した子孫。シェルが先に死んで辿れなくなった場合に使う
 */
function killPtyTree(pty: IPty, signal: NodeJS.Signals, known: readonly number[] = []): number[] {
  if (process.platform === 'win32') {
    const killPty = () => {
      try {
        pty.kill()
      } catch {
        /* すでに終了している */
      }
    }
    // 強制終了（終了時の切り替え）は待たずに閉じる。taskkill は最初の1回だけ
    const command = signal === 'SIGKILL' ? null : windowsTreeKillCommand(pty.pid, process.env.SystemRoot)
    if (!command) killPty()
    // 子孫が無い・すでに終わっているときも taskkill は失敗で返るだけ。どちらでも ConPTY を閉じる
    else execFile(command.file, command.args, { timeout: 3000, windowsHide: true }, killPty)
    return []
  }

  const descendants = [...new Set([...known, ...descendantPids(pty.pid)])]
  for (const pid of descendants) {
    try {
      process.kill(pid, signal)
    } catch {
      /* すでに終了している */
    }
  }

  try {
    process.kill(-pty.pid, signal)
  } catch {
    try {
      pty.kill(signal)
    } catch {
      /* すでに終了している */
    }
  }

  return descendants
}

function shellLabel(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file
  return base.replace(/\.exe$/i, '')
}
