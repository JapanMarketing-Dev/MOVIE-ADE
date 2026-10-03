/**
 * 文字起こしの接続先と費用上限の小さな判定。
 * settings.ts（起動時に読む）からも使うので、重い依存を持たせない。
 */

/** 既定の費用上限（1レビューあたりの概算, USD） */
export const DEFAULT_COST_LIMIT_USD = 1

/** 設定できる費用上限の最大(USD)。打ち間違いで青天井にならないように */
export const MAX_COST_LIMIT_USD = 1000

/**
 * Base URL を `https://host[:port][/path]` の形に揃える（末尾の / と /v1、貼り付けられた
 * /v1/audio/transcriptions は落とす）。http / https 以外や壊れた URL は null。
 */
export function normalizeBaseUrl(raw: string | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  let url: URL
  try { url = new URL(text) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // URL にキーを埋め込ませない（settings.json やログに残るため）
  if (url.username || url.password) return null
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1(\/audio\/transcriptions)?$/, '').replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/** 予約済みの額に今回の分を足すと上限を超えるか。null（上限なし）は常に false */
export function exceedsCostLimit(reservedUsd: number, costUsd: number, limitUsd: number | null | undefined): boolean {
  if (limitUsd === null) return false
  return reservedUsd + costUsd > (limitUsd ?? DEFAULT_COST_LIMIT_USD)
}

/**
 * 保存された上限を直す。null は「上限なし」としてそのまま、正の数は1セント単位に丸めて最大値で抑える。
 * それ以外（0 以下・壊れた値）は undefined（既定の $1）。
 */
export function sanitizeCostLimit(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.min(MAX_COST_LIMIT_USD, Math.max(0.01, Math.round(raw * 100) / 100))
}

/** キーはキーの欄（暗号化して保存）へ。settings.json に平文で残さないよう、認証のヘッダーは追加のヘッダーに置かせない */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'xi-api-key', 'x-goog-api-key', 'cookie'])

/**
 * 接続先の上書き（AiEndpointConfig）を直す。壊れた値は落とす（単体テストから使うため export）。
 * - baseUrl: http / https の URL だけ。利用者が入れた形のまま（/v1 の有無も）残す
 * - model: 前後の空白を落とし 200 文字まで
 * - timeoutMs: 1秒〜10分
 * - headers: 20 個まで。名前は英数字とハイフン、値は改行を含まない表示可能な文字。認証のヘッダーは捨てる
 * - apiVersion: Azure の api-version（英数字・ドット・ハイフン）
 */
export function sanitizeEndpointConfig(raw: unknown): { baseUrl?: string; model?: string; timeoutMs?: number; headers?: Record<string, string>; apiVersion?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: { baseUrl?: string; model?: string; timeoutMs?: number; headers?: Record<string, string>; apiVersion?: string } = {}
  if (typeof r.baseUrl === 'string' && r.baseUrl.trim() && /^https?:\/\//i.test(r.baseUrl.trim())) {
    try {
      const u = new URL(r.baseUrl.trim())
      if (!u.username && !u.password) out.baseUrl = r.baseUrl.trim().slice(0, 500)
    } catch { /* 壊れた URL は捨てる */ }
  }
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim().slice(0, 200)
  if (typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs)) out.timeoutMs = Math.min(600_000, Math.max(1_000, Math.round(r.timeoutMs)))
  if (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)) {
    const headers = Object.entries(r.headers as Record<string, unknown>)
      .filter(([name, value]) => /^[A-Za-z0-9-]{1,64}$/.test(name) && !SECRET_HEADERS.has(name.toLowerCase())
        && typeof value === 'string' && /^[\x20-\x7e]{0,1000}$/.test(value))
      .slice(0, 20)
    if (headers.length) out.headers = Object.fromEntries(headers) as Record<string, string>
  }
  if (typeof r.apiVersion === 'string' && /^[0-9A-Za-z.-]{1,40}$/.test(r.apiVersion)) out.apiVersion = r.apiVersion
  return Object.keys(out).length ? out : undefined
}

/** 提供元ごとの上書きの表を直す。知らない提供元は捨てる */
export function sanitizeEndpointMap<K extends string>(raw: unknown, isKey: (k: unknown) => k is K): Partial<Record<K, ReturnType<typeof sanitizeEndpointConfig> & object>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Partial<Record<K, ReturnType<typeof sanitizeEndpointConfig> & object>> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const cfg = isKey(k) ? sanitizeEndpointConfig(v) : undefined
    if (cfg && isKey(k)) out[k] = cfg
  }
  return Object.keys(out).length ? out : undefined
}
