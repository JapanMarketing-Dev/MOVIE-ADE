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
  /** 判定モデル（System One API）の接続先。Ollama（端末内）はキーが無い（src/shared/decision.ts） */
  | 'vercel-gateway' | 'typesafe' | 'decision-custom'
  /** Cloudflare Workers AI（API トークン）。Ollama・LM Studio は端末内でキーが要らないが、詳細で入れられるよう単位を分ける */
  | 'cloudflare' | 'ollama' | 'lmstudio'

export const AI_VENDORS: readonly AiVendor[] = ['openai', 'groq', 'deepgram', 'elevenlabs', 'google', 'mistral', 'azure', 'openrouter', 'anthropic', 'compatible', 'llm-compatible', 'vercel-gateway', 'typesafe', 'decision-custom', 'cloudflare', 'ollama', 'lmstudio']

/** 送信の形。OpenAI 互換でない API は提供元ごとの小さなアダプタにする（pipeline/stt/cloud.ts） */
export type SttApiKind = 'openai-transcriptions' | 'azure-openai' | 'deepgram' | 'elevenlabs' | 'gemini' | 'chat-audio' | 'cloudflare-run' | 'vercel-transcription'

/**
 * モデルの一覧とキーのページを公式の資料で確かめた日。モデル名は変わるので、古くなったら確かめ直して更新する。
 * 確かめた資料は各提供元の models / pricing / API reference のページ（2026-10-03）。
 */
export const AI_PRESETS_VERIFIED_AT = '2026-10-03'

/** キーに要る権限の種類 */
export type AiKeyPermission = 'cloudflareWorkersAi'

/** モデルの一言の説明（画面では ai.hint.* の文言にする） */
export type AiModelHint = 'balanced' | 'fast' | 'cheap' | 'accurate' | 'best' | 'speakers' | 'timestamps' | 'local' | 'pinned' | 'retiring'

export interface AiModelOption {
  /** API に渡すモデル名そのもの */
  id: string
  hint: AiModelHint
  /** 料金の目安（言語によらない表記。例 $0.0045/min） */
  price?: string
  /** 推奨（既定で選ばれる）。各プリセットにちょうど1つ */
  recommended?: true
}

/** 画面の簡単な経路（提供元 → モデル → キー）に要る情報。プリセットの表に持たせる */
interface PresetSetup {
  /** 選べるモデル。空なら自由入力（Custom・Azure のデプロイ名・LM Studio の読み込んだモデル） */
  models: readonly AiModelOption[]
  /** キーを作るページ（「キーを取得」のリンク） */
  keyUrl?: string
  /** Base URL を利用者ごとに入れる必要がある（Custom・Azure・Cloudflare のアカウント ID 入りの URL） */
  needsBaseUrl?: boolean
  /** Base URL の入力欄の例 */
  baseUrlPlaceholder?: string
  /** Base URL の {account_id} を利用者のアカウント ID で置き換える（Cloudflare）。簡単な経路に Account ID の欄を出す */
  needsAccountId?: boolean
  /** 端末内のサーバー（Ollama・LM Studio）。キーの欄を出さない */
  local?: boolean
  // ── 設定の案内（「キーを作る ↗」などのリンクと、Agent に設定を頼む指示文。2026-10-03 に URL が開けることを確認）──
  /** 使い方の公式ドキュメント */
  docsUrl?: string
  /** ID（Cloudflare の Account ID）の場所を説明する公式のページ */
  idUrl?: string
  /** 端末内のサーバーのダウンロードのページ */
  installUrl?: string
  /** キーを入れておく環境変数の名前（settings.json の apiKeyEnv に書く名前。同じ提供元なら文字起こしと整理で同じ） */
  envVar?: string
  /** ID を入れておく環境変数の名前（Cloudflare。accountId が無いとき main が探す） */
  idEnvVar?: string
  /** キーに要る権限（画面では ai.permission.* の文言） */
  permission?: AiKeyPermission
}

/** 端末の外へ送る文字起こしの提供元。並びは設定の選択欄の順（Custom は最後） */
export type SttRemoteProvider = 'openai' | 'groq' | 'deepgram' | 'elevenlabs' | 'gemini' | 'mistral' | 'openrouter' | 'cloudflare' | 'vercel-gateway' | 'azure' | 'compatible'

export interface SttProviderPreset extends PresetSetup {
  id: SttRemoteProvider
  /** 画面に出す名前（固有名詞なので翻訳しない） */
  label: string
  vendor: AiVendor
  kind: SttApiKind
  /** 既定の Base URL。利用者ごとに違うもの（Azure・Cloudflare・Custom）は空 */
  baseUrl: string
  /** 既定のモデル名＝推奨のモデル（Azure はデプロイ名なので空） */
  model: string
  /** キーが要るか。互換のエンドポイントは省略できる */
  keyRequired: boolean
  /** キーの入力欄に出す例（形式の目安） */
  keyPlaceholder: string
  /** 概算の単価($/分)。分からなければ null（上限は既定の概算 $0.006/分で判定し、「なし」も選べる） */
  pricePerMinuteUsd: number | null
}

/*
 * 文字起こしのプリセット（2026-10-03 に公式の資料で確認）。
 * - ElevenLabs の scribe_v1 は非推奨になったので scribe_v2
 * - Ollama・LM Studio は文字起こしの入口（/v1/audio/transcriptions）を持たないので載せない
 * - Cloudflare・Vercel AI Gateway は OpenAI 互換ではない独自の形（cloud.ts のアダプタ）
 */
export const STT_PROVIDER_PRESETS: Record<SttRemoteProvider, SttProviderPreset> = {
  openai: { id: 'openai', docsUrl: 'https://developers.openai.com/api/docs/guides/speech-to-text', envVar: 'OPENAI_API_KEY',
    label: 'OpenAI', vendor: 'openai', kind: 'openai-transcriptions', baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe',
    keyRequired: true, keyPlaceholder: 'sk-…', pricePerMinuteUsd: 0.0045, keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-transcribe', hint: 'balanced', price: '$0.0045/min', recommended: true },
      { id: 'gpt-4o-mini-transcribe', hint: 'cheap', price: '$0.003/min' },
      { id: 'gpt-4o-transcribe', hint: 'accurate', price: '$0.006/min' },
      { id: 'whisper-1', hint: 'timestamps', price: '$0.006/min' },
    ] },
  groq: { id: 'groq', docsUrl: 'https://console.groq.com/docs/speech-to-text', envVar: 'GROQ_API_KEY',
    label: 'Groq', vendor: 'groq', kind: 'openai-transcriptions', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo',
    keyRequired: true, keyPlaceholder: 'gsk_…', pricePerMinuteUsd: 0.0007, keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'whisper-large-v3-turbo', hint: 'fast', price: '$0.04/h', recommended: true },
      { id: 'whisper-large-v3', hint: 'accurate', price: '$0.111/h' },
    ] },
  deepgram: { id: 'deepgram', docsUrl: 'https://developers.deepgram.com/docs/pre-recorded-audio', envVar: 'DEEPGRAM_API_KEY',
    label: 'Deepgram', vendor: 'deepgram', kind: 'deepgram', baseUrl: 'https://api.deepgram.com/v1', model: 'nova-3',
    keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: 0.0043, keyUrl: 'https://console.deepgram.com/',
    models: [
      { id: 'nova-3', hint: 'balanced', price: '$0.0043/min', recommended: true },
      { id: 'whisper-large', hint: 'accurate', price: '$0.0048/min' },
    ] },
  elevenlabs: { id: 'elevenlabs', docsUrl: 'https://elevenlabs.io/docs/api-reference/speech-to-text/convert', envVar: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs Scribe', vendor: 'elevenlabs', kind: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1', model: 'scribe_v2',
    keyRequired: true, keyPlaceholder: 'sk_…', pricePerMinuteUsd: 0.0037, keyUrl: 'https://elevenlabs.io/app/developers/api-keys',
    models: [{ id: 'scribe_v2', hint: 'accurate', price: '$0.22/h', recommended: true }] },
  gemini: { id: 'gemini', docsUrl: 'https://ai.google.dev/gemini-api/docs/audio', envVar: 'GEMINI_API_KEY',
    label: 'Google Gemini', vendor: 'google', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash',
    keyRequired: true, keyPlaceholder: 'AIza…', pricePerMinuteUsd: 0.003, keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-3.8-flash', hint: 'balanced', recommended: true },
      { id: 'gemini-3.5-flash-lite', hint: 'cheap' },
    ] },
  mistral: { id: 'mistral', docsUrl: 'https://docs.mistral.ai/api/endpoint/audio/transcriptions', envVar: 'MISTRAL_API_KEY',
    label: 'Mistral Voxtral', vendor: 'mistral', kind: 'openai-transcriptions', baseUrl: 'https://api.mistral.ai/v1', model: 'voxtral-mini-latest',
    keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: 0.003, keyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'voxtral-mini-latest', hint: 'balanced', price: '$0.003/min', recommended: true },
      { id: 'voxtral-mini-2602', hint: 'pinned', price: '$0.003/min' },
    ] },
  openrouter: { id: 'openrouter', docsUrl: 'https://openrouter.ai/docs/guides/overview/multimodal/audio', envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter', vendor: 'openrouter', kind: 'chat-audio', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.8-flash',
    keyRequired: true, keyPlaceholder: 'sk-or-…', pricePerMinuteUsd: null, keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'google/gemini-3.8-flash', hint: 'balanced', recommended: true },
      { id: 'google/gemini-3.5-flash-lite', hint: 'cheap' },
      { id: 'mistralai/voxtral-small-24b-2507', hint: 'accurate' },
      { id: 'openai/gpt-audio-mini', hint: 'fast' },
    ] },
  // {account_id} は送る前に main が accountId（無ければ CLOUDFLARE_ACCOUNT_ID）で置き換える。文字起こしは .../ai/run/{model}（末尾の /v1 はアダプタが落とす）
  cloudflare: { id: 'cloudflare', docsUrl: 'https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/', idUrl: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/', envVar: 'CLOUDFLARE_API_TOKEN', idEnvVar: 'CLOUDFLARE_ACCOUNT_ID', permission: 'cloudflareWorkersAi',
    label: 'Cloudflare Workers AI', vendor: 'cloudflare', kind: 'cloudflare-run', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', model: '@cf/openai/whisper-large-v3-turbo',
    keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: 0.0005, keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', needsAccountId: true,
    models: [{ id: '@cf/openai/whisper-large-v3-turbo', hint: 'cheap', price: '$0.0005/min', recommended: true }] },
  'vercel-gateway': { id: 'vercel-gateway', docsUrl: 'https://vercel.com/docs/ai-gateway/modalities/speech-to-text', envVar: 'AI_GATEWAY_API_KEY',
    label: 'Vercel AI Gateway', vendor: 'vercel-gateway', kind: 'vercel-transcription', baseUrl: 'https://ai-gateway.vercel.sh', model: 'openai/gpt-4o-mini-transcribe',
    keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: null, keyUrl: 'https://vercel.com/docs/ai-gateway/authentication-and-byok',
    models: [
      { id: 'openai/gpt-4o-mini-transcribe', hint: 'cheap', recommended: true },
      { id: 'openai/gpt-4o-transcribe', hint: 'accurate' },
      { id: 'google/gemini-3.5-transcribe', hint: 'speakers' },
      { id: 'openai/whisper-1', hint: 'timestamps' },
    ] },
  azure: { id: 'azure', docsUrl: 'https://learn.microsoft.com/en-us/azure/foundry/openai/whisper-quickstart', envVar: 'AZURE_OPENAI_API_KEY',
    label: 'Azure OpenAI', vendor: 'azure', kind: 'azure-openai', baseUrl: '', model: '', keyRequired: true, keyPlaceholder: '', pricePerMinuteUsd: 0.006,
    keyUrl: 'https://portal.azure.com/', needsBaseUrl: true, baseUrlPlaceholder: 'https://<resource>.openai.azure.com', models: [] },
  compatible: { id: 'compatible', label: 'OpenAI compatible', vendor: 'compatible', kind: 'openai-transcriptions', baseUrl: '', model: '', keyRequired: false, keyPlaceholder: '', pricePerMinuteUsd: null,
    needsBaseUrl: true, baseUrlPlaceholder: 'http://localhost:8000/v1', models: [] },
}

export const STT_REMOTE_PROVIDERS = Object.keys(STT_PROVIDER_PRESETS) as SttRemoteProvider[]

/** 整理を API キーで直接呼ぶ提供元。並びは設定の選択欄の順（Custom は最後） */
export type LlmApiProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'vercel-gateway' | 'cloudflare' | 'ollama' | 'lmstudio' | 'compatible'
export type LlmApiKind = 'anthropic-messages' | 'openai-chat' | 'gemini'

export interface LlmProviderPreset extends PresetSetup {
  id: LlmApiProvider
  label: string
  vendor: AiVendor
  kind: LlmApiKind
  baseUrl: string
  /** 既定のモデル名＝推奨のモデル */
  model: string
  keyRequired: boolean
  keyPlaceholder: string
  /** 応答を JSON Schema で縛れるか。縛れなければプロンプトにスキーマを書き、validate.ts で確かめる */
  structuredOutput: boolean
}

/*
 * 整理（LLM）のプリセット（2026-10-03 に公式の資料・各社の公開のモデル一覧で確認）。
 * - OpenRouter・Vercel AI Gateway のモデル名はドット区切り（anthropic/claude-sonnet-5.5）
 * - Claude Haiku 4.5 は 2026-10-15 以降に提供終了の予定
 */
export const LLM_PROVIDER_PRESETS: Record<LlmApiProvider, LlmProviderPreset> = {
  anthropic: { id: 'anthropic', docsUrl: 'https://platform.claude.com/docs/en/build-with-claude/structured-outputs', envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic', vendor: 'anthropic', kind: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5',
    keyRequired: true, keyPlaceholder: 'sk-ant-…', structuredOutput: true, keyUrl: 'https://platform.claude.com/settings/keys',
    models: [
      // 既定は費用と性能の釣り合いで Sonnet。より強いのは Opus、安く速いのは Haiku
      { id: 'claude-sonnet-5-5', hint: 'balanced', price: '$2/$10 per 1M', recommended: true },
      { id: 'claude-opus-5-5', hint: 'best', price: '$4/$20 per 1M' },
      { id: 'claude-haiku-4-5-20251001', hint: 'retiring', price: '$1/$5 per 1M' },
    ] },
  openai: { id: 'openai', docsUrl: 'https://developers.openai.com/api/docs/guides/structured-outputs', envVar: 'OPENAI_API_KEY',
    label: 'OpenAI', vendor: 'openai', kind: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol',
    keyRequired: true, keyPlaceholder: 'sk-…', structuredOutput: true, keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-6.1-sol', hint: 'balanced', price: '$2/$10 per 1M', recommended: true },
      { id: 'gpt-6-luna', hint: 'cheap', price: '$0.10/$0.50 per 1M' },
      { id: 'gpt-6-astra', hint: 'best', price: '$10/$50 per 1M' },
    ] },
  gemini: { id: 'gemini', docsUrl: 'https://ai.google.dev/gemini-api/docs/text-generation', envVar: 'GEMINI_API_KEY',
    label: 'Google Gemini', vendor: 'google', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash',
    keyRequired: true, keyPlaceholder: 'AIza…', structuredOutput: false, keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-3.8-flash', hint: 'balanced', recommended: true },
      { id: 'gemini-3.5-flash-lite', hint: 'cheap' },
      { id: 'gemini-3.1-pro-preview', hint: 'best', price: '$2/$12 per 1M' },
    ] },
  openrouter: { id: 'openrouter', docsUrl: 'https://openrouter.ai/docs/quickstart', envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter', vendor: 'openrouter', kind: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5',
    keyRequired: true, keyPlaceholder: 'sk-or-…', structuredOutput: false, keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'anthropic/claude-sonnet-5.5', hint: 'balanced', recommended: true },
      { id: 'anthropic/claude-opus-5.5', hint: 'best' },
      { id: 'openai/gpt-6.1-sol', hint: 'balanced' },
      { id: 'google/gemini-3.8-flash', hint: 'fast' },
    ] },
  'vercel-gateway': { id: 'vercel-gateway', docsUrl: 'https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions', envVar: 'AI_GATEWAY_API_KEY',
    label: 'Vercel AI Gateway', vendor: 'vercel-gateway', kind: 'openai-chat', baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'anthropic/claude-sonnet-5.5',
    keyRequired: true, keyPlaceholder: '', structuredOutput: false, keyUrl: 'https://vercel.com/docs/ai-gateway/authentication-and-byok',
    models: [
      { id: 'anthropic/claude-sonnet-5.5', hint: 'balanced', recommended: true },
      { id: 'openai/gpt-6.1-sol', hint: 'balanced' },
      { id: 'google/gemini-3.8-flash', hint: 'fast' },
    ] },
  cloudflare: { id: 'cloudflare', docsUrl: 'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/', idUrl: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/', envVar: 'CLOUDFLARE_API_TOKEN', idEnvVar: 'CLOUDFLARE_ACCOUNT_ID', permission: 'cloudflareWorkersAi',
    label: 'Cloudflare Workers AI', vendor: 'cloudflare', kind: 'openai-chat', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', model: '@cf/openai/gpt-oss-120b',
    keyRequired: true, keyPlaceholder: '', structuredOutput: false, keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', needsAccountId: true,
    models: [
      { id: '@cf/openai/gpt-oss-120b', hint: 'balanced', recommended: true },
      { id: '@cf/openai/gpt-oss-20b', hint: 'fast' },
      { id: '@cf/meta/llama-4-scout-17b-16e-instruct', hint: 'cheap' },
    ] },
  ollama: { id: 'ollama', docsUrl: 'https://docs.ollama.com/api/openai-compatibility', installUrl: 'https://ollama.com/download',
    label: 'Ollama', vendor: 'ollama', kind: 'openai-chat', baseUrl: 'http://localhost:11434/v1', model: 'gpt-oss:20b',
    keyRequired: false, keyPlaceholder: '', structuredOutput: false, local: true,
    models: [
      { id: 'gpt-oss:20b', hint: 'local', recommended: true },
      { id: 'qwen3:8b', hint: 'fast' },
      { id: 'llama3.2', hint: 'cheap' },
    ] },
  // LM Studio は読み込んだモデルの名前を使うので、モデルは自由入力
  lmstudio: { id: 'lmstudio', docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat', installUrl: 'https://lmstudio.ai/download',
    label: 'LM Studio', vendor: 'lmstudio', kind: 'openai-chat', baseUrl: 'http://localhost:1234/v1', model: '',
    keyRequired: false, keyPlaceholder: '', structuredOutput: false, local: true, models: [] },
  compatible: { id: 'compatible', label: 'OpenAI compatible', vendor: 'llm-compatible', kind: 'openai-chat', baseUrl: '', model: '', keyRequired: false, keyPlaceholder: '', structuredOutput: false,
    needsBaseUrl: true, baseUrlPlaceholder: 'http://localhost:8000/v1', models: [] },
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
  /**
   * 追加のヘッダー（OpenRouter の HTTP-Referer、社内プロキシなど）。値は文字列か { env: '環境変数の名前' }。
   * 秘密の値（Authorization など）は { env } でだけ置ける（平文では捨てる）。文字起こし・整理・判定で同じ形
   */
  headers?: Record<string, HeaderValue>
  /** Azure OpenAI の api-version */
  apiVersion?: string
  /**
   * キーを読む環境変数の名前（例: OPENAI_API_KEY）。アプリの環境変数 → 開いているプロジェクトの .env →
   * 設定フォルダの .env の順に探す（src/main/settingsKeys.ts）
   */
  apiKeyEnv?: string
  /** 平文のキー。settings.json に書いた人だけが使う（読める人には見える）。apiKeyEnv・保存したキーより優先 */
  apiKey?: string
  /** 認証の形。省略時はプリセットの既定（OpenAI 互換は Bearer、Anthropic は x-api-key など）。none はキーを送らない */
  authScheme?: AuthScheme
  /** authScheme が header のときのヘッダー名（例: x-api-key, api-key）。値はキーそのもの */
  authHeader?: string
  /** baseUrl の {account_id} を置き換える値（Cloudflare）。省略時は環境変数 CLOUDFLARE_ACCOUNT_ID */
  accountId?: string
}

/** 追加のヘッダーの値。文字列はそのまま、{ env } は送る直前に環境変数から読む（秘密をファイルに書かないため） */
export type HeaderValue = string | { env: string }

/** 認証の形。文字起こし・整理・判定で同じ */
export type AuthScheme = 'bearer' | 'header' | 'none'

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** 平文では置かせない秘密のヘッダー（{ env } なら置ける） */
const SECRET_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'xi-api-key', 'x-goog-api-key', 'cookie', 'cf-aig-authorization'])
/** 送る側が自分で付けるヘッダー。上書きさせない */
const RESERVED_HEADER_NAMES = new Set(['host', 'content-length', 'content-type', 'connection', 'transfer-encoding'])

/**
 * 追加のヘッダーを直す（3つの接続先で共通）。legacyEnv は開発中だけあった headersEnv（{ 名前: 環境変数 }）で、{ env } へ移す。
 * 32 個まで。名前は英数字とハイフン、平文の値は改行を含まない表示可能な文字で、秘密のヘッダーは平文なら捨てる。
 */
export function sanitizeHeaders(raw: unknown, legacyEnv?: unknown): Record<string, HeaderValue> | undefined {
  const out: Record<string, HeaderValue> = {}
  const add = (name: string, value: unknown) => {
    if (!HEADER_NAME.test(name) || RESERVED_HEADER_NAMES.has(name.toLowerCase()) || Object.keys(out).length >= 32) return
    if (typeof value === 'string') {
      if (!SECRET_HEADER_NAMES.has(name.toLowerCase()) && /^[\x20-\x7e]{0,2000}$/.test(value)) out[name] = value
      return
    }
    const env = value && typeof value === 'object' ? (value as { env?: unknown }).env : undefined
    if (typeof env === 'string' && ENV_VAR_NAME.test(env.trim())) out[name] = { env: env.trim() }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [name, value] of Object.entries(raw as Record<string, unknown>)) add(name, value)
  if (legacyEnv && typeof legacyEnv === 'object' && !Array.isArray(legacyEnv)) {
    for (const [name, env] of Object.entries(legacyEnv as Record<string, unknown>)) if (!(name in out)) add(name, { env })
  }
  return Object.keys(out).length ? out : undefined
}

/** 送る直前に { env } を読む。見つからない環境変数のヘッダーは付けない */
export function resolveHeaderValues(headers: Record<string, HeaderValue> | undefined, getEnv: (name: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const resolved = typeof value === 'string' ? value : getEnv(value.env)?.trim()
    if (resolved !== undefined && resolved !== '' && /^[\x20-\x7e]{0,4000}$/.test(resolved)) out[name] = resolved
  }
  return out
}

/** URL の {account_id} を accountId（無ければ環境変数 CLOUDFLARE_ACCOUNT_ID）で置き換える。見つからなければそのまま */
export function fillAccountId(url: string, accountId: string | undefined, getEnv: (name: string) => string | undefined): string {
  if (!url.includes('{account_id}')) return url
  const account = accountId?.trim() || getEnv('CLOUDFLARE_ACCOUNT_ID')?.trim()
  return account ? url.replaceAll('{account_id}', encodeURIComponent(account)) : url
}

/** 画面の「名前: 値」の行。値が ${VAR} なら環境変数から読む（{ env }） */
export function parseHeaderLines(text: string): Record<string, HeaderValue> {
  const out: Record<string, HeaderValue> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9-]{1,64})\s*:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const env = /^\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}$/.exec(m[2]!)
    out[m[1]!] = env ? { env: env[1]! } : m[2]!
  }
  return out
}

export function formatHeaderLines(headers: Record<string, HeaderValue> | undefined): string {
  return Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : `\${${v.env}}`}`).join('\n')
}

/**
 * 送信に付ける認証のヘッダー。endpoint.authScheme が無ければ fallback（提供元ごとの既定の形）をそのまま使う。
 * キーが無ければ何も付けない。キーの値はここから外へ出さない（ログに出さないこと）。
 */
export function authHeaders(endpoint: { authScheme?: AuthScheme; authHeader?: string } | undefined, key: string | undefined, fallback: Record<string, string>): Record<string, string> {
  if (!key || endpoint?.authScheme === 'none') return {}
  if (endpoint?.authScheme === 'bearer') return { Authorization: `Bearer ${key}` }
  if (endpoint?.authScheme === 'header' && endpoint.authHeader) return { [endpoint.authHeader]: key }
  return fallback
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
    // { env } は main が送る前に解決済み（src/main/settingsKeys.ts の resolveEndpointRefs）。残っていれば付けない
    headers: Object.fromEntries(Object.entries(override?.headers ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
    ...(override?.apiVersion ? { apiVersion: override.apiVersion } : {}),
  }
}

/** キー（要る場合）・Base URL・モデル名が揃っていて、送れる状態か。通信はしない */
export function isEndpointReady(preset: { baseUrl: string; model: string; keyRequired: boolean; local?: boolean }, override: AiEndpointConfig | undefined, hasKey: boolean): boolean {
  // 端末内のサーバー（Ollama・LM Studio）は、利用者が一度選ぶまで「使える」に数えない（起動していないかもしれないため）
  if (preset.local && !override) return false
  const ep = resolveEndpoint(preset, override)
  return (!preset.keyRequired || hasKey) && /^https?:\/\/\S+$/i.test(ep.baseUrl) && !!ep.model
}

// ───────────── 設定の簡単な経路（提供元 → モデル → キー）。画面とテストが同じ判定を使う ─────────────

type SetupPreset = PresetSetup & { model: string }

/** 推奨のモデル。一覧が無い（自由入力の）プリセットは既定のモデル名（空のことがある） */
export function recommendedModel(preset: SetupPreset): string {
  return preset.models.find((m) => m.recommended)?.id ?? preset.model
}

/** 今選ばれているモデル。上書きが無ければ推奨 */
export function currentModel(preset: SetupPreset, override: AiEndpointConfig | undefined): string {
  return override?.model?.trim() || recommendedModel(preset)
}

/**
 * モデルを選ぶ。推奨と同じなら上書きを消す（未設定＝推奨。プリセットの推奨が変われば追従する）。
 * 端末内のサーバーは「使う」と選んだ印として残す。Base URL・ヘッダーなどほかの項目は消さない。
 */
export function selectModel(preset: SetupPreset, override: AiEndpointConfig | undefined, modelId: string): AiEndpointConfig | undefined {
  const next: AiEndpointConfig = { ...override }
  const id = modelId.trim()
  if (id && (id !== recommendedModel(preset) || preset.local)) next.model = id
  else delete next.model
  return Object.keys(next).length ? next : undefined
}

export interface SetupLayout {
  /** モデルは一覧から選ぶか、自由入力か */
  modelField: 'select' | 'text'
  /** Base URL を詳細の外に出すか（Custom・Azure だけ） */
  baseUrlField: boolean
  /** Account ID を詳細の外に出すか（Cloudflare。Base URL の {account_id} に入る） */
  accountIdField: boolean
  /** キーの欄を出すか（端末内のサーバーは出さない） */
  keyField: boolean
  /** 「詳細」を描くか（オンボーディングでは描かず、設定画面への1行の案内にする） */
  advanced: boolean
}

/** 提供元の設定の出し方。ほかの項目（タイムアウト・ヘッダー・認証・費用の上限）は「詳細」へ畳む */
export function setupLayout(preset: SetupPreset, opts: { onboarding: boolean }): SetupLayout {
  return {
    modelField: preset.models.length > 0 ? 'select' : 'text',
    baseUrlField: preset.needsBaseUrl === true,
    accountIdField: preset.needsAccountId === true,
    keyField: preset.local !== true,
    advanced: !opts.onboarding,
  }
}

/** 文字起こしの節の出し方。言語は設定画面だけ（オンボーディングは自動のまま）。端末内は推奨モデルのダウンロードを出す */
export function transcriptionLayout(provider: 'local' | SttRemoteProvider, opts: { onboarding: boolean }): { language: boolean; downloadModel: boolean; setup: SetupLayout | null } {
  return {
    language: !opts.onboarding,
    downloadModel: provider === 'local',
    setup: provider === 'local' ? null : setupLayout(STT_PROVIDER_PRESETS[provider], opts),
  }
}

/**
 * 画面・メッセージに出す提供元の名前。固有名詞はそのまま、OpenAI 互換だけは訳す。
 * main は t、renderer は useT() の t を渡す（言語の決め方が違うため、ここでは辞書を読まない）。
 */
export function providerLabel(p: { id: string; label: string }, translate: (key: 'ai.providerCompatible') => string): string {
  return p.id === 'compatible' ? translate('ai.providerCompatible') : p.label
}
