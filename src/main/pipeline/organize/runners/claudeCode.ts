/**
 * Claude Code を非対話モードで呼ぶ runner。
 *
 * 実測で確認したコマンドライン（claude 2.1.287）:
 *   claude -p --output-format json --json-schema <schema> --model <model> \
 *          --tools "" --strict-mcp-config --permission-prompts none \
 *          --disable-slash-commands --setting-sources ""
 *   （プロンプトは stdin から流す。cwd をセッションフォルダに固定する）
 *
 * - `--tools ""` で組み込みツールを全部落とす。入力はプロンプトに埋め込むのでツールは不要。
 * - `--setting-sources ""` でユーザー・プロジェクト・ローカルの設定とCLAUDE.mdを読ませない
 *   （レビュー対象リポジトリの CLAUDE.md が指示に混ざるのを防ぐ）。
 * - `--bare` は使わない。OAuth（サブスク）を読まず ANTHROPIC_API_KEY を要求するため。
 * - cwd は実行ごとに作る空の一時フォルダ（セッションフォルダもプロジェクトも見せない。security-2 [3]）。
 *   プロンプトにはページの作者が書ける文字が入るので、ツールを切った上での念押し
 * - `--no-session-persistence` で会話（文字起こし）をディスクに残さない
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmRunner, RunnerRequest, RunnerResult } from '../runner'
import { RunnerError } from '../runner'
import { extractJson, spawnText, type SpawnTextOptions, type SpawnTextResult } from '../spawn'
import { isInheritedAgentSessionEnv } from '../../../inheritedAgentEnv'

export interface ClaudeCodeRunnerOptions {
  /** 実行パス。既定は PATH 上の claude */
  binary?: string;
  /** 既定モデル */
  model?: string;
  /** 推論の深さ。構造化抽出なので既定は low（速度優先） */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 選択中のアカウントの環境変数（CLAUDE_CONFIG_DIR など）。実行のたびに読む。src/main/accounts の resolveAgentEnv を渡す */
  accountEnv?: () => Record<string, string>
  /** 子プロセスの起動（単体テストで偽物に差し替える） */
  spawn?: (opt: SpawnTextOptions) => Promise<SpawnTextResult>
}

interface ClaudeResultEnvelope {
  type?: string
  subtype?: string
  is_error?: boolean;
  /** スキーマ指定時のパース済み出力。これがあれば優先して使う */
  structured_output?: unknown
  result?: string
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  total_cost_usd?: number
  usage?: Record<string, unknown>
  modelUsage?: unknown
}

/**
 * 子プロセスへ渡さない環境変数。
 * - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN があると、サブスクのOAuthより優先され
 *   従量課金のAPIで実行されてしまう（NF-2・EXT-9 に反する）。必ず外す。
 * - CLAUDE_CODE_* は親の Claude Code セッションの情報なので引き継がせない。
 */
const STRIPPED_ENV_EXACT = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (STRIPPED_ENV_EXACT.includes(k)) continue
    if (k.startsWith('CLAUDE_CODE_')) continue
    // 親の Claude Code / Codex のセッションの印（CLAUDECODE、CODEX_THREAD_ID など）も渡さない
    if (isInheritedAgentSessionEnv(k, v)) continue
    env[k] = v
  }
  return env
}

export class ClaudeCodeRunner implements LlmRunner {
  readonly id = 'claude-code'
  private readonly binary: string
  private readonly defaultModel: string
  private readonly effort: string
  private readonly accountEnv: () => Record<string, string>
  private readonly spawn: (opt: SpawnTextOptions) => Promise<SpawnTextResult>

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.accountEnv = options.accountEnv ?? (() => ({}))
    this.spawn = options.spawn ?? spawnText
    this.binary = options.binary ?? 'claude'
    this.defaultModel = options.model ?? 'haiku'
    this.effort = options.effort ?? 'low'
  }

  async available(): Promise<boolean> {
    try {
      const r = await this.spawn({
        binary: this.binary,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 15_000,
        env: childEnv(),
      })
      return r.code === 0
    } catch {
      // CLI が入っていない（想定内）
      return false
    }
  }

  buildArgs(req: RunnerRequest): string[] {
    return [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(req.schema),
      '--model', req.model ?? this.defaultModel,
      '--effort', this.effort,
      '--tools', '',
      '--strict-mcp-config',
      '--permission-prompts', 'none',
      '--disable-slash-commands',
      '--setting-sources', '',
      '--no-session-persistence',
    ]
  }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    const args = this.buildArgs(req)
    // 作業フォルダは空の一時フォルダ（req.cwd のセッションフォルダは使わない）
    const workDir = await mkdtemp(join(tmpdir(), 'ade-claude-work-'))
    let r: SpawnTextResult
    try {
      r = await this.spawn({
        binary: this.binary,
        args,
        cwd: workDir,
        timeoutMs: req.timeoutMs,
        stdin: req.prompt,
        env: { ...childEnv(), ...this.accountEnv() },
      })
    } finally {
      // 一時フォルダの片付け（OS が後で消す。想定内）
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }

    if (r.code !== 0) {
      throw new RunnerError(
        `claude が異常終了しました (code=${r.code})`,
        'exit',
        r.commandLine,
        r.stderr.slice(-2000),
      )
    }

    const envelope = parseEnvelope(r.stdout)
    if (envelope?.is_error) {
      throw new RunnerError(
        `claude がエラーを返しました: ${envelope.result ?? envelope.subtype ?? 'unknown'}`,
        'exit',
        r.commandLine,
        r.stderr.slice(-2000),
      )
    }

    // --json-schema を使うと structured_output にパース済みの出力が入る。
    // result は同じ内容の文字列だが二重エンコードになることがあるので、こちらを優先する。
    const usage = envelopeUsage(envelope)
    if (envelope?.structured_output !== undefined) {
      return {
        raw: JSON.stringify(envelope.structured_output),
        elapsedMs: r.elapsedMs,
        commandLine: r.commandLine,
        stderrTail: r.stderr.slice(-500) || undefined,
        usage,
      }
    }

    const text = envelope?.result ?? r.stdout
    return {
      raw: extractJson(text),
      elapsedMs: r.elapsedMs,
      commandLine: r.commandLine,
      stderrTail: r.stderr.slice(-500) || undefined,
      usage,
    }
  }
}

/**
 * `--output-format json` の stdout は「全イベントのJSON配列」。
 * 最後の `type:"result"` 要素を取り出す（1イベントだけのオブジェクトやJSONLにも耐える）。
 */
export function parseEnvelope(stdout: string): ClaudeResultEnvelope | undefined {
  const pick = (v: unknown): ClaudeResultEnvelope | undefined => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        const found = pick(v[i])
        if (found) return found
      }
      return undefined
    }
    if (v && typeof v === 'object') {
      const o = v as ClaudeResultEnvelope
      if (o.type === 'result' || o.structured_output !== undefined || typeof o.result === 'string') return o
    }
    return undefined
  }

  const whole = tryParse(stdout)
  if (whole !== undefined) {
    const found = pick(whole)
    if (found) return found
  }
  // JSONL で来た場合
  for (const line of stdout.split('\n').reverse()) {
    const parsed = tryParse(line.trim())
    const found = parsed === undefined ? undefined : pick(parsed)
    if (found) return found
  }
  return undefined
}

function tryParse(s: string): unknown {
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    // JSON でない出力を見分けている（想定内）
    return undefined
  }
}

function envelopeUsage(e: ClaudeResultEnvelope | undefined): Record<string, unknown> | undefined {
  if (!e) return undefined
  const u = e.usage ?? {}
  return {
    input_tokens: u.input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    output_tokens: u.output_tokens,
    output_tokens_details: u.output_tokens_details,
    duration_api_ms: e.duration_api_ms,
    num_turns: e.num_turns,
    total_cost_usd: e.total_cost_usd,
  }
}
