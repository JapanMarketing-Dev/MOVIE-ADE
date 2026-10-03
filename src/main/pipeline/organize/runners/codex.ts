/**
 * Codex CLI を非対話モードで呼ぶ runner。
 *
 * 実測で確認したコマンドライン（codex-cli 0.155.1）:
 *   codex exec --sandbox read-only --output-schema <file> -o <file> \
 *              -C <session dir> --skip-git-repo-check --ephemeral -m <model> -
 *   （末尾の `-` で stdin からプロンプトを読む。結果は -o のファイルに書かれる）
 *
 * - `--sandbox read-only` で書き込みを禁止、`-C` で作業フォルダをセッションフォルダに限定。
 * - `--skip-git-repo-check` はセッションフォルダがgitリポジトリ外でも動かすため。
 * - `--ephemeral` でセッションファイルをディスクに残さない（文字起こしを ~/.codex に残さない）。
 * - `--output-schema` は OpenAI の strict モードに渡るため、スキーマ側の制約に注意（src/schema.ts）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmRunner, RunnerRequest, RunnerResult } from '../runner'
import { RunnerError } from '../runner'
import { extractJson, spawnText } from '../spawn'
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
}

export class CodexRunner implements LlmRunner {
  readonly id = 'codex'
  private readonly binary: string
  private readonly defaultModel?: string
  private readonly accountEnv: () => Record<string, string>

  constructor(options: CodexRunnerOptions = {}) {
    this.accountEnv = options.accountEnv ?? (() => ({}))
    this.binary = options.binary ?? 'codex'
    this.defaultModel = options.model
  }

  async available(): Promise<boolean> {
    try {
      const r = await spawnText({
        binary: this.binary,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 15_000,
        env: codexEnv(),
      })
      return r.code === 0
    } catch {
      return false
    }
  }

  buildArgs(schemaPath: string, outPath: string, req: RunnerRequest): string[] {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--output-schema', schemaPath,
      '-o', outPath,
      '-C', req.cwd,
      '--skip-git-repo-check',
      '--ephemeral',
      // ユーザーの config.toml を読まない（認証は CODEX_HOME から）。これが無いと:
      //  - config の model が ChatGPT アカウントで使えないモデルだと exec が失敗する（実測）
      //  - ユーザーの MCP サーバー・プラグインが起動し、遅くなるうえ入力が外部へ渡りうる
      '--ignore-user-config',
      '--ignore-rules',
    ]
    const model = req.model ?? this.defaultModel
    if (model) args.push('-m', model)
    args.push('-')
    return args
  }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    const dir = await mkdtemp(join(tmpdir(), 'ade-codex-'))
    const schemaPath = join(dir, 'schema.json')
    const outPath = join(dir, 'out.json')
    try {
      await writeFile(schemaPath, JSON.stringify(req.schema), 'utf8')
      const args = this.buildArgs(schemaPath, outPath, req)

      const r = await spawnText({
        binary: this.binary,
        args,
        cwd: req.cwd,
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

      const text = await readFile(outPath, 'utf8').catch(() => '')
      const body = text.trim() || r.stdout
      return {
        raw: extractJson(body),
        elapsedMs: r.elapsedMs,
        commandLine: r.commandLine,
        stderrTail: r.stderr.slice(-500) || undefined,
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
