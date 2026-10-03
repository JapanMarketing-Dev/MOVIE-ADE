/**
 * 利用者が自分のキー・自分の接続先で使う AI の提供元の一覧（プリセット）。
 * main（送信）と renderer（設定の画面の既定値）の両方が読む。
 *
 * - どの提供元も、利用者の端末から直接送る。開発者の中継サーバーは無い。
 * - Base URL・モデル名は既定値で、設定で上書きできる（追加のヘッダー・タイムアウトも）。
 * - 単価は費用の上限の判定に使う**概算**（2026-10 時点の公開価格の目安）。正確な料金は各社の料金表を見ること。
 *   分からないものは null にし、上限を「なし」にできるようにする。
 * - キーは提供元（vendor）ごとに1つ保存し、文字起こしと整理で同じ提供元なら共有する（pipeline/stt/keys.ts）。
 */

/** キーを保存する単位 */
export type AiVendor =
  | 'openai' | 'groq' | 'deepgram' | 'elevenlabs' | 'google' | 'mistral' | 'azure' | 'openrouter' | 'anthropic'
  /** 文字起こしの OpenAI 互換のエンドポイント */
  | 'compatible'
  /** 整理の OpenAI 互換のエンドポイント */
  | 'llm-compatible'

export const AI_VENDORS: readonly AiVendor[] = ['openai', 'groq', 'deepgram', 'elevenlabs', 'google', 'mistral', 'azure', 'openrouter', 'anthropic', 'compatible', 'llm-compatible']

/** 送信の形。OpenAI 互換でない API は提供元ごとの小さなアダプタにする（pipeline/stt/cloud.ts） */
export type SttApiKind = 'openai-transcriptions' | 'azure-openai' | 'deepgram' | 'elevenlabs' | 'gemini' | 'chat-audio'

/** 端末の外へ送る文字起こしの提供元 */
export type SttRemoteProvider = 'openai' | 'groq' | 'deepgram' | 'elevenlabs' | 'gemini' | 'mistral' | 'azure' | 'openrouter' | 'compatible'

export interface SttProviderPreset {
  id: SttRemoteProvider
  /** 画面に出す名前（固有名詞なので翻訳しない） */
  label: string
  vendor: AiVendor
  kind: SttApiKind
  /** 既定の Base URL。azure は利用者のリソースごとに違うので空 */
  baseUrl: string
  /** 既定のモデル名（azure はデプロイ名） */
  model: string
  /** キーが要るか。互換のエンドポイントは省略できる */
  keyRequired: boolean
  /** キーの入力欄に出す例（形式の目安） */
  keyPlaceholder: string
  /** 概算の単価($/分)。分からなければ null（上限は既定の概算 $0.006/分で判定し、「なし」も選べる） */
  pricePerMinuteUsd: number | null
}

export const STT_PROVIDER_PRESETS: Record<SttRemoteProvider, SttProviderPreset> = {
  openai: { id: 'openai', label: 'OpenAI', vendor: 'openai', kind: 'openai-transcriptions', baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe', keyRequired: true, keyPlaceholder: 'sk-…', pricePerMinuteUsd: 0.0045 },
  groq: { id: 'groq', label: 'Groq', vendor: 'groq', kind: 'openai-transcriptions', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyRequired: true, keyPlaceholder: 'gsk_…', pricePerMinuteUsd: 0.0007 },
  deepgram: { id: 'deepgram', label: 'Deepgram', vendor: 'deepgram', kind: 'deepgram', baseUrl: 'https://api.deepgram.com/v1', model: 'nova-3', keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: 0.0043 },
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs Scribe', vendor: 'elevenlabs', kind: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1', model: 'scribe_v1', keyRequired: true, keyPlaceholder: 'sk_…', pricePerMinuteUsd: 0.0067 },
  gemini: { id: 'gemini', label: 'Google Gemini', vendor: 'google', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', keyRequired: true, keyPlaceholder: 'AIza…', pricePerMinuteUsd: 0.003 },
  mistral: { id: 'mistral', label: 'Mistral Voxtral', vendor: 'mistral', kind: 'openai-transcriptions', baseUrl: 'https://api.mistral.ai/v1', model: 'voxtral-mini-latest', keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: 0.001 },
  azure: { id: 'azure', label: 'Azure OpenAI', vendor: 'azure', kind: 'azure-openai', baseUrl: '', model: '', keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: 0.006 },
  openrouter: { id: 'openrouter', label: 'OpenRouter', vendor: 'openrouter', kind: 'chat-audio', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash', keyRequired: true, keyPlaceholder: 'sk-or-…', pricePerMinuteUsd: null },
  compatible: { id: 'compatible', label: 'OpenAI compatible', vendor: 'compatible', kind: 'openai-transcriptions', baseUrl: '', model: '', keyRequired: false, keyPlaceholder: '', pricePerMinuteUsd: null },
}

export const STT_REMOTE_PROVIDERS = Object.keys(STT_PROVIDER_PRESETS) as SttRemoteProvider[]

/** 整理を API キーで直接呼ぶ提供元 */
export type LlmApiProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'compatible'
export type LlmApiKind = 'anthropic-messages' | 'openai-chat' | 'gemini'

export interface LlmProviderPreset {
  id: LlmApiProvider
  label: string
  vendor: AiVendor
  kind: LlmApiKind
  baseUrl: string
  model: string
  keyRequired: boolean
  keyPlaceholder: string
  /** 応答を JSON Schema で縛れるか。縛れなければプロンプトにスキーマを書き、validate.ts で確かめる */
  structuredOutput: boolean
  /** モデル名の入力欄に出す候補（自由に入力もできる） */
  modelExamples?: readonly string[]
}

export const LLM_PROVIDER_PRESETS: Record<LlmApiProvider, LlmProviderPreset> = {
  anthropic: { id: 'anthropic', label: 'Anthropic', vendor: 'anthropic', kind: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', keyRequired: true, keyPlaceholder: 'sk-ant-…', structuredOutput: true,
    // 既定は費用と性能の釣り合いで Sonnet。より強いのは Opus、安く速いのは Haiku
    modelExamples: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'] },
  openai: { id: 'openai', label: 'OpenAI', vendor: 'openai', kind: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', keyRequired: true, keyPlaceholder: 'sk-…', structuredOutput: true },
  gemini: { id: 'gemini', label: 'Google Gemini', vendor: 'google', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', keyRequired: true, keyPlaceholder: 'AIza…', structuredOutput: false },
  openrouter: { id: 'openrouter', label: 'OpenRouter', vendor: 'openrouter', kind: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5', keyRequired: true, keyPlaceholder: 'sk-or-…', structuredOutput: false },
  compatible: { id: 'compatible', label: 'OpenAI compatible', vendor: 'llm-compatible', kind: 'openai-chat', baseUrl: '', model: '', keyRequired: false, keyPlaceholder: '', structuredOutput: false },
}

export const LLM_API_PROVIDERS = Object.keys(LLM_PROVIDER_PRESETS) as LlmApiProvider[]

/** 「指摘を整理」の実行方法。CLI（各自の契約）か、API キーで直接 */
export type OrganizeRunnerId = 'codex' | 'claude-code' | `api:${LlmApiProvider}`

/** 接続先ごとの上書き（settings.json に保存。キーは入れない） */
export interface AiEndpointConfig {
  baseUrl?: string
  model?: string
  /** 1回の送信の待ち時間(ms) */
  timeoutMs?: number
  /** 追加のヘッダー（OpenRouter の HTTP-Referer、社内プロキシなど）。秘密の値はキーの欄へ */
  headers?: Record<string, string>
  /** Azure OpenAI の api-version */
  apiVersion?: string
}

export const DEFAULT_AZURE_API_VERSION = '2024-06-01'

export function isSttRemoteProvider(v: unknown): v is SttRemoteProvider {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STT_PROVIDER_PRESETS, v)
}

export function isLlmApiProvider(v: unknown): v is LlmApiProvider {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LLM_PROVIDER_PRESETS, v)
}

export function isOrganizeRunnerId(v: unknown): v is OrganizeRunnerId {
  return v === 'codex' || v === 'claude-code' || (typeof v === 'string' && v.startsWith('api:') && isLlmApiProvider(v.slice(4)))
}

/** 既定値に上書きを重ねた、実際に使う接続先 */
export function resolveEndpoint<P extends { baseUrl: string; model: string }>(preset: P, override: AiEndpointConfig | undefined): { baseUrl: string; model: string; timeoutMs?: number; headers: Record<string, string>; apiVersion?: string } {
  return {
    baseUrl: override?.baseUrl?.trim() || preset.baseUrl,
    model: override?.model?.trim() || preset.model,
    ...(override?.timeoutMs ? { timeoutMs: override.timeoutMs } : {}),
    headers: override?.headers ?? {},
    ...(override?.apiVersion ? { apiVersion: override.apiVersion } : {}),
  }
}

/** キー（要る場合）・Base URL・モデル名が揃っていて、送れる状態か。通信はしない */
export function isEndpointReady(preset: { baseUrl: string; model: string; keyRequired: boolean }, override: AiEndpointConfig | undefined, hasKey: boolean): boolean {
  const ep = resolveEndpoint(preset, override)
  return (!preset.keyRequired || hasKey) && /^https?:\/\/\S+$/i.test(ep.baseUrl) && !!ep.model
}

/**
 * 画面・メッセージに出す提供元の名前。固有名詞はそのまま、OpenAI 互換だけは訳す。
 * main は t、renderer は useT() の t を渡す（言語の決め方が違うため、ここでは辞書を読まない）。
 */
export function providerLabel(p: { id: string; label: string }, translate: (key: 'ai.providerCompatible') => string): string {
  return p.id === 'compatible' ? translate('ai.providerCompatible') : p.label
}
