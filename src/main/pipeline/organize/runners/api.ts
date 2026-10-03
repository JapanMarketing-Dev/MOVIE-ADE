/**
 * 「指摘を整理」を、利用者の API キーで LLM へ直接送る runner。
 * CLI（Claude Code / Codex）と同じ「プロンプト → JSON の文字列」を返し、検証は validate.ts に任せる。
 *
 * - anthropic-messages: {base}/v1/messages。output_config.format の json_schema で出力を縛る
 *   （Claude Opus 5.5 などは tool_choice で道具を強制できないため、structured outputs を使う）
 * - openai-chat: {base}/v1/chat/completions。OpenAI は response_format の json_schema（strict）で縛る。
 *   OpenRouter・互換のエンドポイントは対応がまちまちなので、スキーマをプロンプトに書いて JSON だけを返させる
 * - gemini: {base}/models/{model}:generateContent。responseMimeType=application/json と、プロンプトのスキーマ
 *
 * 利用者の端末から、利用者のキーで直接送る。キーはヘッダーにだけ入れ、ログ・エラーに出さない。
 * 配布版は環境変数のキーを読まない（キーは呼び出し側が pipeline/stt/keys.ts から渡す）。
 * Anthropic の SDK は入れず fetch で送る（ほかの提供元と同じ形にし、Base URL・ヘッダーを利用者が変えられるようにするため）。
 */
import { LLM_PROVIDER_PRESETS, authHeaders, providerLabel, resolveEndpoint, type AiEndpointConfig, type LlmApiProvider } from '@shared/aiProviders'
import { t } from '@shared/i18n'
import { normalizeBaseUrl } from '../../stt/endpoint'
import { redact } from '../../stt/openai'
import type { LlmRunner, RunnerRequest, RunnerResult } from '../runner'
import { RunnerError } from '../runner'
import { extractJson } from '../spawn'
import { extractUsage, recordApiCall } from '../../../decision/callLog'

/** 非ストリーミングで HTTP のタイムアウトに収まる出力の上限 */
const MAX_OUTPUT_TOKENS = 16_000
const ANTHROPIC_VERSION = '2023-06-01'

export interface ApiRunnerOptions {
  provider: LlmApiProvider
  endpoint?: AiEndpointConfig
  apiKey?: string
}

export interface LlmHttpRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** スキーマで縛れない提供元へ、JSON だけを返させる指示 */
export function schemaInstruction(schema: unknown): string {
  return 'Respond with a single JSON object that conforms to the following JSON Schema. ' +
    'Output only the JSON object: no prose, no Markdown, no code fences.\n' + JSON.stringify(schema)
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export class ApiLlmRunner implements LlmRunner {
  readonly id: string
  private readonly preset
  private readonly ep

  constructor(private readonly opt: ApiRunnerOptions) {
    this.preset = LLM_PROVIDER_PRESETS[opt.provider]
    this.ep = resolveEndpoint(this.preset, opt.endpoint)
    this.id = `api:${opt.provider}`
  }

  get label(): string {
    return providerLabel(this.preset, t)
  }

  /** キー（要る場合）と、接続先・モデル名が揃っているか。通信はしない */
  async available(): Promise<boolean> {
    return (!this.preset.keyRequired || !!this.opt.apiKey) && !!this.baseUrl() && !!this.ep.model
  }

  private baseUrl(): string | null {
    return this.preset.kind === 'gemini' ? (/^https?:\/\//i.test(this.ep.baseUrl) ? this.ep.baseUrl.trim().replace(/\/+$/, '') : null) : normalizeBaseUrl(this.ep.baseUrl)
  }

  /** 要求の組み立て（単体テストから使うため public） */
  buildRequest(req: RunnerRequest): LlmHttpRequest {
    const base = this.baseUrl()
    if (!base) throw new RunnerError(t('stt.errors.badBaseUrl'), 'spawn')
    const key = this.opt.apiKey ?? ''
    const model = req.model || this.ep.model
    const extra = this.ep.headers
    // 認証の形は設定（authScheme / authHeader）で変えられる。無ければ提供元の既定の形。キーが無ければ付けない
    const auth = (fallback: Record<string, string>) => authHeaders(this.opt.endpoint, key, fallback)
    switch (this.preset.kind) {
      case 'anthropic-messages':
        return {
          url: `${base}/v1/messages`,
          headers: { ...extra, ...auth({ 'x-api-key': key }), 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: req.prompt }],
            output_config: { format: { type: 'json_schema', schema: req.schema } },
          }),
        }
      case 'openai-chat': {
        const structured = this.preset.structuredOutput
        return {
          url: `${base}/v1/chat/completions`,
          headers: { ...extra, ...auth({ Authorization: `Bearer ${key}` }), 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: structured
              ? [{ role: 'user', content: req.prompt }]
              : [{ role: 'system', content: schemaInstruction(req.schema) }, { role: 'user', content: req.prompt }],
            ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'organize_output', strict: true, schema: req.schema } } } : {}),
          }),
        }
      }
      case 'gemini':
        return {
          url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
          headers: { ...extra, ...auth({ 'x-goog-api-key': key }), 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: schemaInstruction(req.schema) }] },
            contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        }
    }
  }

  /** 応答から本文の文字列と使用量を取り出す。拒否・打ち切りは RunnerError（単体テストから使うため public） */
  parseResponse(json: unknown): { text: string; usage?: Record<string, unknown> } {
    const r = rec(json)
    const usage = r.usage && typeof r.usage === 'object' ? r.usage as Record<string, unknown>
      : r.usageMetadata && typeof r.usageMetadata === 'object' ? r.usageMetadata as Record<string, unknown> : undefined
    switch (this.preset.kind) {
      case 'anthropic-messages': {
        if (r.stop_reason === 'refusal') throw new RunnerError(t('organize.api.refusal', { label: this.label }), 'empty')
        if (r.stop_reason === 'max_tokens') throw new RunnerError(t('organize.api.truncated', { label: this.label }), 'empty')
        const text = arr(r.content).map(rec).filter((b) => b.type === 'text').map((b) => str(b.text)).join('')
        return { text, usage }
      }
      case 'openai-chat': {
        const choice = rec(arr(r.choices)[0])
        const message = rec(choice.message)
        if (str(message.refusal)) throw new RunnerError(t('organize.api.refusal', { label: this.label }), 'empty')
        if (choice.finish_reason === 'length') throw new RunnerError(t('organize.api.truncated', { label: this.label }), 'empty')
        const content = message.content
        return { text: typeof content === 'string' ? content : arr(content).map((c) => str(rec(c).text)).join(''), usage }
      }
      case 'gemini': {
        if (str(rec(r.promptFeedback).blockReason)) throw new RunnerError(t('organize.api.refusal', { label: this.label }), 'empty')
        const candidate = rec(arr(r.candidates)[0])
        if (candidate.finishReason === 'MAX_TOKENS') throw new RunnerError(t('organize.api.truncated', { label: this.label }), 'empty')
        return { text: arr(rec(candidate.content).parts).map((p) => str(rec(p).text)).join(''), usage }
      }
    }
  }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    if (this.preset.keyRequired && !this.opt.apiKey) throw new RunnerError(t('organize.api.keyMissing', { label: this.label }), 'spawn')
    const http = this.buildRequest(req)
    const commandLine = `POST ${http.url} model=${req.model || this.ep.model}`
    const started = Date.now()
    // フッターの「API の使用量」へ数だけ載せる（本文・キーは渡さない）。失敗した送信も記録する
    const record = (status: number, json?: unknown) => recordApiCall({ kind: 'organize', provider: this.opt.provider, model: req.model || this.ep.model,
      status, latencyMs: Date.now() - started, requestBytes: Buffer.byteLength(http.body), ...(json === undefined ? {} : llmUsage(json)) })
    let res: Response
    try {
      res = await fetch(http.url, { method: 'POST', headers: http.headers, body: http.body,
        signal: AbortSignal.timeout(this.ep.timeoutMs ?? req.timeoutMs) })
    } catch (e) {
      record(0)
      const name = e instanceof Error ? e.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') throw new RunnerError(t('organize.api.timeout', { label: this.label }), 'timeout', commandLine)
      throw new RunnerError(t('stt.check.unreachable', { base: http.url.replace(/\/v1\/.*$|\/models\/.*$/, '') }), 'spawn', commandLine)
    }
    const elapsedMs = Date.now() - started
    if (!res.ok) {
      record(res.status)
      // 失敗の本文は説明に使うだけ（想定内）
      const body = redact(await res.text().catch(() => ''), this.opt.apiKey).slice(0, 500)
      throw new RunnerError(describeLlmFailure(res.status, body, this.label), 'exit', commandLine, body)
    }
    const json: unknown = await res.json()
    record(res.status, json)
    const { text, usage } = this.parseResponse(json)
    return { raw: extractJson(text), elapsedMs, commandLine, ...(usage ? { usage } : {}) }
  }
}

/**
 * 応答からトークン数と、提供元が返した費用を取り出す（使用量の記録用）。
 * Anthropic・OpenAI 系は extractUsage、Gemini は usageMetadata、OpenRouter は usage.cost。費用は推測しない
 */
export function llmUsage(json: unknown): { inputTokens?: number; outputTokens?: number; costUsd?: number; costSource?: 'provider' } {
  const r = rec(json)
  const base = extractUsage(json)
  const meta = rec(r.usageMetadata)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const inputTokens = base.inputTokens ?? num(meta.promptTokenCount)
  const outputTokens = base.outputTokens ?? num(meta.candidatesTokenCount)
  const costUsd = base.costUsd ?? num(rec(r.usage).cost)
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd, costSource: 'provider' as const } : {}) }
}

/** HTTP の失敗を、利用者が直せる言葉にする */
export function describeLlmFailure(status: number, body: string, label: string): string {
  if (status === 401 || status === 403) return t('stt.check.auth', { label, status })
  if ((status === 400 || status === 404 || status === 422) && /model/i.test(body)) return t('stt.check.model', { label, status })
  if (status === 404 || status === 405) return t('organize.api.notFound', { label, status })
  if (status === 429) return t('stt.check.rateLimit', { label })
  if (status >= 500) return t('stt.check.server', { label, status })
  return t('organize.api.failed', { label, status })
}

/** 接続の確認に使う小さなスキーマ */
const CHECK_SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }

/** 「接続を確認」。短い質問を1回送り、JSON が返るかを見る（数トークン分の費用がかかる） */
export async function checkLlmRunner(opt: ApiRunnerOptions): Promise<{ ok: boolean; message: string }> {
  const runner = new ApiLlmRunner(opt)
  try {
    const r = await runner.run({ prompt: 'Reply with {"ok": true}.', schema: CHECK_SCHEMA, cwd: process.cwd(), timeoutMs: 30_000 })
    JSON.parse(r.raw)
    return { ok: true, message: t('organize.api.checkOk', { label: runner.label, model: resolveEndpoint(LLM_PROVIDER_PRESETS[opt.provider], opt.endpoint).model }) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
