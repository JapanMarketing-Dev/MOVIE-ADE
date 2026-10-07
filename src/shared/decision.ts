import { authHeaders, fillAccountId, resolveHeaderValues, sanitizeHeaders, type AiKeyPermission, type AiVendor, type AuthScheme, type HeaderValue } from './aiProviders'

/**
 * 判定モデル（System One 互換の decision API）の設定とプリセット。main と renderer の両方が読む。
 *
 * Ferret 自身は判定しない。設定を有効にすると:
 *   - main がローカルの中継（src/main/decision/relay.ts）を立て、Agent のターミナルに中継の URL・モデル・画像の可否を
 *     環境変数で渡す（キーは渡さない。中継がキーと追加のヘッダーを付けて本当の接続先へ送る）
 *   - feedback.md と Agent への指示文に「指摘1件につき1回だけ判定し、結果からもう1回だけ直すかを決めて人に渡す」受け入れ確認の手順を足す（ループしない）
 * プリセットは入力欄を埋めるだけで、どの値も書き換えられる（Custom で System One 互換の API ならどこでも使える）。
 */

export type DecisionPreset = 'ollama' | 'cloudflare' | 'vercel' | 'typesafe' | 'openai' | 'custom'

/** キーの付け方。bearer は Authorization: Bearer、header は authHeader の名前のヘッダーにキーをそのまま、none は付けない（3機能で共通の AuthScheme） */
export type DecisionAuthScheme = AuthScheme

export interface DecisionPricing {
  /** 入力 100 万トークンあたりの USD */
  inputPer1M?: number
  /** 出力 100 万トークンあたりの USD */
  outputPer1M?: number
}

/** 画像の渡し方。base64 はそのままの base64（Ollama）、data-uri は data:image/jpeg;base64,…（Cloudflare Workers AI は必須） */
export type DecisionImageFormat = 'base64' | 'data-uri'

interface DecisionModelOption {
  id: string
  /** 画像（before / after）を読めるか */
  images: boolean
}

interface DecisionPresetDef {
  id: DecisionPreset
  /** 画面に出す名前（固有名詞なので翻訳しない。custom だけ訳す） */
  label: string
  /** 保存したキー（pipeline/stt/keys.ts）の提供元。キーの要らない端末内の Ollama は null */
  vendor: AiVendor | null
  /** 完全なリクエスト URL。{account_id} と {model} は送る直前に置き換える */
  endpoint: string
  model: string
  images: boolean
  imageFormat: DecisionImageFormat
  authScheme: DecisionAuthScheme
  /** キーを読む環境変数の名前（プリセットを選んだときに入力欄へ入れる） */
  apiKeyEnv?: string
  models: readonly DecisionModelOption[]
  /** 料金（公開されているものだけ。分からなければ入れない＝推測しない） */
  pricing?: DecisionPricing
  // ── 設定の案内（文字起こし・整理のプリセットと同じ項目。@shared/aiProviders。2026-10-03 に URL が開けることを確認）──
  /** キーを作るページ */
  keyUrl?: string
  /** 使い方の公式ドキュメント */
  docsUrl?: string
  /** ID（Cloudflare の Account ID）の場所を説明するページ */
  idUrl?: string
  /** 端末内のサーバーのダウンロードのページ */
  installUrl?: string
  /** キーを入れておく環境変数の名前（apiKeyEnv と同じ。共通の案内の部品が読む名前） */
  envVar?: string
  /** ID を入れておく環境変数の名前（Cloudflare） */
  idEnvVar?: string
  /** キーに要る権限 */
  permission?: AiKeyPermission
}

const CLOUDFLARE_ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/{model}'

export const DECISION_PRESETS: Record<DecisionPreset, DecisionPresetDef> = {
  ollama: { id: 'ollama', label: 'Ollama', vendor: null, docsUrl: 'https://docs.ollama.com/capabilities/decision', installUrl: 'https://ollama.com/download', endpoint: 'http://localhost:11434/v1/systemone', model: 'clef-flash', images: true, imageFormat: 'base64', authScheme: 'none',
    models: [{ id: 'clef-flash', images: true }, { id: 'clef', images: true }, { id: 'nimble', images: false }, { id: 'tev1', images: false }] },
  // 実機で確認（2026-10-03）: 画像は data URI でないと 422（"image must be an embedded base64 data URI"）。応答は { result, success } で包まれる
  cloudflare: { id: 'cloudflare', label: 'Cloudflare Workers AI', vendor: 'cloudflare', endpoint: CLOUDFLARE_ENDPOINT, model: 'clef-flash', images: true, imageFormat: 'data-uri', authScheme: 'bearer', apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    envVar: 'CLOUDFLARE_API_TOKEN', idEnvVar: 'CLOUDFLARE_ACCOUNT_ID', permission: 'cloudflareWorkersAi', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/', idUrl: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/',
    models: [{ id: 'clef-flash', images: true }, { id: 'clef', images: true }] },
  // AI Gateway の System One はモデル一覧に画像対応の記載が無いので、文だけとして始める（利用者が変えられる）
  vercel: { id: 'vercel', label: 'Vercel AI Gateway', vendor: 'vercel-gateway', endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', images: false, imageFormat: 'base64', authScheme: 'bearer', apiKeyEnv: 'AI_GATEWAY_API_KEY',
    envVar: 'AI_GATEWAY_API_KEY', keyUrl: 'https://vercel.com/docs/ai-gateway/authentication-and-byok', docsUrl: 'https://vercel.com/ai-gateway/models',
    models: [{ id: 'typesafe-ai/jev', images: false }, { id: 'convaiinnovations/laya', images: false }] },
  typesafe: { id: 'typesafe', label: 'TypeSafe', vendor: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', images: false, imageFormat: 'base64', authScheme: 'bearer', apiKeyEnv: 'TYPESAFE_API_KEY',
    envVar: 'TYPESAFE_API_KEY', keyUrl: 'https://console.typesafe.ai', docsUrl: 'https://docs.typesafe.ai',
    models: [{ id: 'jev-latest', images: false }, { id: 'jev-preview', images: false }] },
  // OpenAI の Decisions API は System One と形が違う（input / questions の配列 / answers の配列）。中継が写し合う（src/main/decision/openaiDecisions.ts）。
  // 画像は data URL だけを受け付ける。料金は入力 $0.10 / 1M（出力・キャッシュの課金なし。2026-10-07 の公式ガイド）
  openai: { id: 'openai', label: 'OpenAI', vendor: 'openai', endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', images: true, imageFormat: 'data-uri', authScheme: 'bearer', apiKeyEnv: 'OPENAI_API_KEY',
    envVar: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://developers.openai.com/api/docs/guides/decisions',
    pricing: { inputPer1M: 0.1, outputPer1M: 0 },
    models: [{ id: 'gpt-6-luna', images: true }] },
  custom: { id: 'custom', label: 'Custom', vendor: 'decision-custom', endpoint: '', model: '', images: false, imageFormat: 'base64', authScheme: 'bearer', models: [] }
}

export const DECISION_PRESET_IDS = Object.keys(DECISION_PRESETS) as DecisionPreset[]

/** 合格のしきい値（done の P(true)）の既定値 */
export const DEFAULT_PASS_THRESHOLD = 0.7

/** settings.json の decision。キーの値は apiKey（平文。非推奨）か apiKeyEnv（環境変数の名前）か、保存したキー */
export interface DecisionPreferences {
  /** 有効にするまで中継も指示文の追加もしない */
  enabled: boolean
  preset: DecisionPreset
  /** 完全なリクエスト URL。{account_id} / {model} を含められる。空ならプリセット */
  endpoint?: string
  model?: string
  /** 画像を送るか。省略時はプリセット */
  images?: boolean
  /** 画像の渡し方（base64 / data-uri）。省略時はプリセット */
  imageFormat?: DecisionImageFormat
  /** Cloudflare のアカウント ID。空なら環境変数 CLOUDFLARE_ACCOUNT_ID */
  accountId?: string
  authScheme?: DecisionAuthScheme
  /** authScheme が header のときのヘッダー名（例: x-api-key） */
  authHeader?: string
  /** 追加のヘッダー。値は文字列か { env: 変数名 }（秘密はファイルに書かず環境変数から。3機能で共通の形） */
  headers?: Record<string, HeaderValue>
  apiKeyEnv?: string
  apiKey?: string
  pricing?: DecisionPricing
  /** 合格のしきい値（0.5〜0.99）。省略時は 0.7 */
  passThreshold?: number
  /** 中継から接続先への待ち時間(ms)。省略時は 120 秒 */
  timeoutMs?: number
}

export const DEFAULT_DECISION_PREFERENCES: DecisionPreferences = { enabled: false, preset: 'ollama' }

function isDecisionPreset(v: unknown): v is DecisionPreset {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DECISION_PRESETS, v)
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const price = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000 ? v : undefined)

/** 読み込んだ値を型どおりに直す。壊れた値は捨てる（以前の backend / baseUrl もここで移す） */
export function sanitizeDecisionPreferences(raw: unknown): DecisionPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DECISION_PREFERENCES }
  const r = raw as Record<string, unknown>
  // 以前の形（backend + baseUrl）。baseUrl に /v1/systemone を付けて完全な URL にする
  const legacyPreset = r.backend === 'ollama' || r.backend === 'vercel' || r.backend === 'typesafe' || r.backend === 'custom' ? r.backend : undefined
  const legacyBase = str(r.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '')
  const endpoint = str(r.endpoint) || (legacyBase ? `${legacyBase}/v1/systemone` : '')
  const model = str(r.model, 200)
  const accountId = str(r.accountId, 64)
  const authHeader = str(r.authHeader, 64)
  const apiKeyEnv = str(r.apiKeyEnv, 128)
  const apiKey = str(r.apiKey, 500)
  // 以前の headersEnv（名前 → 変数名）は { env } へ移す。平文の秘密ヘッダー・予約ヘッダーは捨てる（aiProviders.ts）
  const headers = sanitizeHeaders(r.headers, r.headersEnv)
  const pricing = r.pricing && typeof r.pricing === 'object' ? { inputPer1M: price((r.pricing as DecisionPricing).inputPer1M), outputPer1M: price((r.pricing as DecisionPricing).outputPer1M) } : {}
  const threshold = typeof r.passThreshold === 'number' && Number.isFinite(r.passThreshold) ? Math.min(0.99, Math.max(0.5, Math.round(r.passThreshold * 100) / 100)) : undefined
  const timeoutMs = typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs) ? Math.min(600_000, Math.max(1_000, Math.round(r.timeoutMs))) : undefined
  return {
    enabled: r.enabled === true,
    preset: isDecisionPreset(r.preset) ? r.preset : legacyPreset ?? DEFAULT_DECISION_PREFERENCES.preset,
    // http(s) 以外の URL は捨てる（file: などへ送らない）
    ...(/^https?:\/\/\S+$/i.test(endpoint) ? { endpoint } : {}),
    ...(model && /^[\x21-\x7e]+$/.test(model) ? { model } : {}),
    ...(typeof r.images === 'boolean' ? { images: r.images } : {}),
    ...(r.imageFormat === 'base64' || r.imageFormat === 'data-uri' ? { imageFormat: r.imageFormat } : {}),
    ...(accountId && /^[A-Za-z0-9_-]+$/.test(accountId) ? { accountId } : {}),
    ...(r.authScheme === 'bearer' || r.authScheme === 'header' || r.authScheme === 'none' ? { authScheme: r.authScheme } : {}),
    ...(authHeader && HEADER_NAME.test(authHeader) ? { authHeader } : {}),
    ...(headers ? { headers } : {}),
    ...(ENV_NAME.test(apiKeyEnv) ? { apiKeyEnv } : {}),
    ...(apiKey && /^[\x21-\x7e]{1,500}$/.test(apiKey) ? { apiKey } : {}),
    ...(pricing.inputPer1M !== undefined || pricing.outputPer1M !== undefined
      ? { pricing: { ...(pricing.inputPer1M !== undefined ? { inputPer1M: pricing.inputPer1M } : {}), ...(pricing.outputPer1M !== undefined ? { outputPer1M: pricing.outputPer1M } : {}) } } : {}),
    ...(threshold !== undefined ? { passThreshold: threshold } : {}),
    ...(timeoutMs ? { timeoutMs } : {})
  }
}

/**
 * Ollama でモデルを決めていないときに、この PC に合うモデル（@shared/localModels の推奨。clef / clef-flash）を入れる。
 * main（中継・ターミナルの環境変数）と画面（欄の表示・Agent への指示文）の両方がこれを通す。ほかの提供元・決めてあるモデルはそのまま
 */
export function withLocalDecisionModel<T extends Pick<DecisionPreferences, 'preset' | 'model'>>(prefs: T, localModel: string | undefined): T {
  return prefs.preset === 'ollama' && !prefs.model && localModel ? { ...prefs, model: localModel } : prefs
}

/**
 * プリセットを選んだときの入力欄の値。キーの値・しきい値・料金・有効の状態は持ち越す。
 * localModel は Ollama のときに入れるモデル（この PC のメモリから選んだ推奨。省略時はプリセットの clef-flash）
 */
export function applyDecisionPreset(prefs: DecisionPreferences, preset: DecisionPreset, localModel?: string): DecisionPreferences {
  const def = DECISION_PRESETS[preset]
  const { enabled, apiKey, passThreshold, timeoutMs } = prefs
  return sanitizeDecisionPreferences({
    enabled, preset, endpoint: def.endpoint, model: preset === 'ollama' && localModel ? localModel : def.model, images: def.images, imageFormat: def.imageFormat, authScheme: def.authScheme,
    ...(def.apiKeyEnv ? { apiKeyEnv: def.apiKeyEnv } : {}), ...(def.pricing ? { pricing: def.pricing } : {}),
    ...(preset === prefs.preset && prefs.accountId ? { accountId: prefs.accountId } : {}),
    ...(apiKey ? { apiKey } : {}), ...(passThreshold !== undefined ? { passThreshold } : {}), ...(timeoutMs ? { timeoutMs } : {})
  })
}

interface ResolvedDecision {
  preset: DecisionPreset
  /** {account_id} / {model} を置き換えた完全な URL。置き換えられなければ missing に名前が入る */
  url: string
  model: string
  images: boolean
  imageFormat: DecisionImageFormat
  authScheme: DecisionAuthScheme
  /** authScheme が header のときのヘッダー名 */
  authHeader: string
  /** 追加のヘッダー（{ env } は解決済み。見つからない変数のヘッダーは付けない） */
  headers: Record<string, string>
  passThreshold: number
  timeoutMs: number
  pricing?: DecisionPricing
  /** URL を組み立てられない理由（account_id が無い・URL が無いなど） */
  missing: string[]
}

/** 設定とプリセットと環境変数から、実際に使う接続先を決める（キーは別に解決する） */
export function resolveDecision(prefs: DecisionPreferences, getEnv: (name: string) => string | undefined = () => undefined): ResolvedDecision {
  const def = DECISION_PRESETS[prefs.preset]
  const model = prefs.model || def.model
  const missing: string[] = []
  let url = fillAccountId(prefs.endpoint || def.endpoint, prefs.accountId, getEnv)
  if (!url) missing.push('endpoint')
  if (url.includes('{account_id}')) missing.push('account_id')
  if (url.includes('{model}')) {
    if (model) url = url.replaceAll('{model}', model)
    else missing.push('model')
  }
  const headers = resolveHeaderValues(prefs.headers, getEnv)
  return {
    preset: prefs.preset, url, model,
    images: prefs.images ?? def.images,
    imageFormat: prefs.imageFormat ?? def.imageFormat,
    authScheme: prefs.authScheme ?? def.authScheme,
    authHeader: prefs.authHeader || 'Authorization',
    headers,
    passThreshold: prefs.passThreshold ?? DEFAULT_PASS_THRESHOLD,
    timeoutMs: prefs.timeoutMs ?? 120_000,
    ...(prefs.pricing ?? def.pricing ? { pricing: prefs.pricing ?? def.pricing } : {}),
    missing
  }
}

/** キーを付けるヘッダー（名前と値）。キーが無いか authScheme が none なら null */
export function decisionAuthHeader(resolved: Pick<ResolvedDecision, 'authScheme' | 'authHeader'>, key: string | undefined): Record<string, string> {
  return authHeaders({ authScheme: resolved.authScheme, authHeader: resolved.authHeader }, key, {})
}

/** 画像を読めると知られているモデルか（Clef / Clef Flash / OpenAI の gpt-6-luna）。設定の画面の目安に使う */
export function decisionModelSupportsImages(model: string): boolean {
  const base = model.trim().toLowerCase().split('/').pop()!.split(':')[0]!
  return base === 'clef' || base === 'clef-flash' || base === 'gpt-6-luna'
}

/** Agent の PTY に渡す環境変数（キーは入れない） */
export const DECISION_ENV = {
  url: 'FERRET_DECISION_URL',
  model: 'FERRET_DECISION_MODEL',
  images: 'FERRET_DECISION_IMAGES',
  imageFormat: 'FERRET_DECISION_IMAGE_FORMAT'
} as const

/**
 * @deprecated 改名前の名前。古い指示文で動いている Agent のために1リリースだけ同じ値を併せて渡す。次のリリースで消す
 */
export const LEGACY_DECISION_ENV = {
  url: 'MOVIE_ADE_DECISION_URL',
  model: 'MOVIE_ADE_DECISION_MODEL',
  images: 'MOVIE_ADE_DECISION_IMAGES',
  imageFormat: 'MOVIE_ADE_DECISION_IMAGE_FORMAT'
} as const

/** 親のアプリから受け継いではいけない判定モデルの環境変数の接頭辞（新旧） */
export const DECISION_ENV_PREFIXES = ['FERRET_DECISION_', 'MOVIE_ADE_DECISION_'] as const

/**
 * Agent のターミナルに渡した値（有効・モデル・画像の可否）が変わるか。変わるなら、開いているターミナルの開き直しを促す。
 * 中継の URL はアプリを閉じるまで変わらないので、URL・キー・ヘッダー・しきい値の変更では促さない
 */
export function decisionTerminalEnvChanged(prev: DecisionPreferences, next: DecisionPreferences): boolean {
  const view = (p: DecisionPreferences) => {
    const r = resolveDecision(p)
    return `${p.enabled}|${r.model}|${r.images}|${r.imageFormat}`
  }
  return view(prev) !== view(next)
}

/**
 * 設定の案内（「キーを作る ↗」などのリンクと「Agent に設定を頼む」指示文。@shared/setupGuide）に渡す形。
 * 判定モデルのプリセットから写して作る。Ollama の確かめ方は OpenAI 互換の /v1/models を使う（/v1/systemone は GET できない）
 */
export function decisionSetupGuide(raw: Pick<DecisionPreferences, 'preset' | 'endpoint' | 'model' | 'apiKeyEnv' | 'authScheme'>, label: string, localModel?: string): import('./setupGuide').SetupGuide {
  const prefs = withLocalDecisionModel(raw, localModel)
  const def = DECISION_PRESETS[prefs.preset]
  const endpoint = prefs.endpoint || def.endpoint
  const local = prefs.preset === 'ollama'
  return {
    label,
    keyRequired: (prefs.authScheme ?? def.authScheme) !== 'none' && prefs.preset !== 'custom',
    local,
    needsAccountId: endpoint.includes('{account_id}'),
    needsBaseUrl: prefs.preset === 'custom' && !endpoint,
    baseUrl: local ? endpoint.replace(/\/v1\/systemone\/?$/, '/v1') : endpoint,
    model: prefs.model || def.model,
    ...(def.keyUrl ? { keyUrl: def.keyUrl } : {}),
    ...(def.idUrl ? { idUrl: def.idUrl } : {}),
    ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}),
    ...(def.installUrl ? { installUrl: def.installUrl } : {}),
    ...(prefs.apiKeyEnv || def.envVar ? { envVar: prefs.apiKeyEnv || def.envVar } : {}),
    ...(def.idEnvVar ? { idEnvVar: def.idEnvVar } : {}),
    ...(def.permission ? { permission: def.permission } : {})
  }
}
