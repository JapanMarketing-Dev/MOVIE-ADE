/**
 * Codex CLI を非対話モードで呼ぶ runner。
 *
 * 実測で確認したコマンドライン（codex-cli 0.155.1）:
 *   codex exec --sandbox read-only --output-schema <file> -o <file> \
 *              -C <session dir> --skip-git-repo-check --ephemeral -m <model> -
 *   （末尾の `-` で stdin からプロンプトを読む。結果は -o のファイルに書かれる）
 *
 * 整理はプロンプトに埋め込んだ文を JSON に直すだけで、ツールは要らない。一方プロンプトには、レビューしたページの文字
 * （ページの作者が書ける）が入るので、「~/.ssh を読め」のような注入に従われるとローカルのファイルがモデルへ渡る
 * （セキュリティの指摘 security-2 [3]）。`--sandbox read-only` は書き込みを止めるだけで読み取りは止めないので、
 * ツールそのものを外し、作業フォルダも空にする:
 * - シェル・exec・画像の閲覧・ブラウザ・コンピュータ操作・Web 検索・MCP・プラグイン・スキル・フックなど、
 *   ファイルや外へ届くツールを `-c features.<name>=false` / `-c web_search="disabled"` で全部切る
 *   （知らない版では無視される `-c` を使う。`--disable` は版によって知らない名前で失敗しうる）
 * - `-C` と cwd は、実行ごとに作る空の一時フォルダ（セッションフォルダもプロジェクトも見せない）。
 *   AGENTS.md も読ませない（project_doc_max_bytes=0）
 * - シェルの環境変数も渡さない設定にする（shell_environment_policy.inherit="none"。ツールを切った上での念押し）
 * - `--skip-git-repo-check` は一時フォルダが git リポジトリ外でも動かすため。
 * - `--ephemeral` でセッションファイルをディスクに残さない（文字起こしを ~/.codex に残さない）。
 * - `--output-schema` は OpenAI の strict モードに渡るため、スキーマ側の制約に注意（src/schema.ts）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmRunner, RunnerRequest, RunnerResult } from '../runner'
import { RunnerError } from '../runner'
import { extractJson, spawnText, type SpawnTextOptions, type SpawnTextResult } from '../spawn'
import { childEnv } from './claudeCode';

/**
 * Codex も OPENAI_API_KEY が環境にあると従量課金で動く可能性があるため外す
 * （ログインは CODEX_HOME の認証情報を使う）。
 */
function codexEnv(): NodeJS.ProcessEnv {
  const env = childEnv()
  delete env.OPENAI_API_KEY
  delete env.OPENAI_BASE_URL
  return env
}

export interface CodexRunnerOptions {
  binary?: string
  model?: string
  /** 選択中のアカウントの環境変数（CODEX_HOME）。実行のたびに読む。src/main/accounts の resolveAgentEnv を渡す */
  accountEnv?: () => Record<string, string>
  /** 子プロセスの起動（単体テストで偽物に差し替える。本物の CLI を呼ばずに引数と作業フォルダを確かめる） */
  spawn?: (opt: SpawnTextOptions) => Promise<SpawnTextResult>
}

/**
 * 整理では使わない（＝切る）機能。ファイル・シェル・ネットワーク・外部のツールへ届くもの。
 * codex-cli 0.160.0 で、空の CODEX_HOME に `codex <この -c 全部> features list` を流して確かめた（モデルは呼ばない）:
 *   - 25個は false になる。unified_exec だけは -c・--disable・config.toml のどれでも true のまま（この版では切れない）。
 *     シェルのツールを出すかどうかの元のスイッチは shell_tool で、unified_exec はその実装の種類なので、shell_tool=false で
 *     シェルは出ない想定。unified_exec は切れる版のために残す
 *   - 知らないキーは黙って受け付けられる（落ちない）。型のあるキー（web_search・approval_policy・
 *     shell_environment_policy.inherit・mcp_servers・project_doc_max_bytes）は、値が違えば起動前に落ちるので、
 *     下の値は正しいと確かめてある
 */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'view_image', 'image_generation',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use',
  'apps', 'plugins', 'remote_plugin', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest',
  'hooks', 'code_mode_host', 'multi_agent', 'in_app_local_automation', 'workspace_dependencies', 'memories',
  'goals', 'sleep_tool', 'worktrees',
] as const

export class CodexRunner implements LlmRunner {
  readonly id = 'codex'
  private readonly binary: string
  private readonly defaultModel?: string
  private readonly accountEnv: () => Record<string, string>
  private readonly spawn: (opt: SpawnTextOptions) => Promise<SpawnTextResult>

  constructor(options: CodexRunnerOptions = {}) {
    this.accountEnv = options.accountEnv ?? (() => ({}))
    this.spawn = options.spawn ?? spawnText
    this.binary = options.binary ?? 'codex'
    this.defaultModel = options.model
  }

  async available(): Promise<boolean> {
    try {
      const r = await this.spawn({
        binary: this.binary,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 15_000,
        env: codexEnv(),
      })
      return r.code === 0
    } catch {
      // CLI が入っていない（想定内）
      return false
    }
  }

  /** workDir は空の一時フォルダ（req.cwd のセッションフォルダは使わない） */
  buildArgs(schemaPath: string, outPath: string, req: RunnerRequest, workDir: string): string[] {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--output-schema', schemaPath,
      '-o', outPath,
      '-C', workDir,
      '--skip-git-repo-check',
      '--ephemeral',
      // ユーザーの config.toml を読まない（認証は CODEX_HOME から）。これが無いと:
      //  - config の model が ChatGPT アカウントで使えないモデルだと exec が失敗する（実測）
      //  - ユーザーの MCP サーバー・プラグインが起動し、遅くなるうえ入力が外部へ渡りうる
      '--ignore-user-config',
      '--ignore-rules',
      // ツールを全部切る（security-2 [3]）。ファイルを読む・コマンドを動かす・外へ出る手段を持たせない
      ...CODEX_DISABLED_FEATURES.flatMap((name) => ['-c', `features.${name}=false`]),
      '-c', 'web_search="disabled"',
      '-c', 'mcp_servers={}',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'shell_environment_policy.inherit="none"',
      '-c', 'approval_policy="never"',
    ]
    const model = req.model ?? this.defaultModel
    if (model) args.push('-m', model)
    args.push('-')
    return args
  }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    // スキーマと出力は CLI 本体が読み書きするフォルダ、作業フォルダ（-C / cwd）はそれとは別の空のフォルダ
    const dir = await mkdtemp(join(tmpdir(), 'ade-codex-'))
    const workDir = await mkdtemp(join(tmpdir(), 'ade-codex-work-'))
    const schemaPath = join(dir, 'schema.json')
    const outPath = join(dir, 'out.json')
    try {
      await writeFile(schemaPath, JSON.stringify(req.schema), 'utf8')
      const args = this.buildArgs(schemaPath, outPath, req, workDir)

      const r = await this.spawn({
        binary: this.binary,
        args,
        cwd: workDir,
        timeoutMs: req.timeoutMs,
        stdin: req.prompt,
        env: { ...codexEnv(), ...this.accountEnv() },
      })

      if (r.code !== 0) {
        throw new RunnerError(
          `codex が異常終了しました (code=${r.code})`,
          'exit',
          r.commandLine,
          r.stderr.slice(-2000),
        )
      }

      // 出力ファイルが無ければ標準出力を使う（想定内）
  const text = await readFile(outPath, 'utf8').catch(() => '')
      const body = text.trim() || r.stdout
      return {
        raw: extractJson(body),
        elapsedMs: r.elapsedMs,
        commandLine: r.commandLine,
        stderrTail: r.stderr.slice(-500) || undefined,
      }
    } finally {
      // 一時フォルダの片付け（OS が後で消す。想定内）
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
