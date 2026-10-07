/**
 * 判定モデルの「接続を確かめる」（利用者がボタンを押したときだけ）。
 *
 * 中継と同じ接続先・同じキーとヘッダーで、短い noul を1回送り、つながったかだけを返す。
 * 合否の判定はしない（判定は Agent が行う。Ferret は判定しない）。従量課金なので呼び出しの記録にも数える。
 * 返す文は利用者向けの短い文だけ。キー・応答の本文は文に入れない。
 *
 * Electron に依存させない（単体テストで fetch を差し替えるため）。
 */
import type { ApiCallRecord } from '@shared/apiUsage'
import { t } from '@shared/i18n'
import { SMALL_JSON_MAX_BYTES, readBoundedJson } from '../boundedResponse'
import { extractUsage } from './callLog'
import type { RelayUpstream } from './relay'
import { decisionWireFor, fromOpenAiDecisions, toOpenAiDecisions } from './openaiDecisions'

export interface DecisionTestResult {
  ok: boolean
  /** 利用者向けの短い文 */
  message: string
  model?: string
  latencyMs?: number
}

/** 確かめるために送る本文（どのプロバイダでも読める最小の問い） */
const DECISION_TEST_BODY = (model: string) => ({
  model,
  state: 'The sky is blue on a clear day.',
  questions: { ok: { type: 'noul', instructions: 'Is this statement true?' } }
})

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** 応答に System One の答え（answers.ok.noul）があるか。Cloudflare の { result } の包みも見る */
export function hasTestAnswer(body: unknown): boolean {
  const top = rec(body)
  const answers = rec(rec(top.result).answers ?? top.answers)
  const noul = rec(answers.ok).noul
  return typeof noul === 'number' && Number.isFinite(noul)
}

/** HTTP の状態を利用者向けの短い文にする（応答の本文は使わない） */
export function describeTestFailure(status: number, model: string): string {
  if (status === 401 || status === 403) return t('decision.test.auth', { status })
  if (status === 404) return t('decision.test.notFound', { model })
  if (status === 413) return t('decision.test.tooLarge')
  if (status === 429) return t('decision.test.rateLimit')
  if (status === 529) return t('decision.test.overloaded')
  if (status === 400 || status === 422) return t('decision.test.invalid', { status })
  if (status >= 500) return t('decision.test.server', { status })
  return t('decision.test.failed', { status })
}

/**
 * 1回だけ送って確かめる。upstream が投げた（URL・アカウント ID が無い等）ときは、その文をそのまま返す。
 * fake を渡すと本物を呼ばずに決まった結果を返す（E2E・単体テスト用）
 */
export async function checkDecision(opt: {
  upstream: () => Promise<RelayUpstream>
  onCall?: (record: ApiCallRecord) => void
  fetch?: typeof fetch
  fake?: boolean
  now?: () => Date
}): Promise<DecisionTestResult> {
  let up: RelayUpstream
  try {
    up = await opt.upstream()
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : t('decision.test.config') }
  }
  if (opt.fake) return { ok: true, message: t('decision.test.ok', { model: up.model, ms: 0 }), model: up.model, latencyMs: 0 }
  // OpenAI の Decisions API へは同じ問いを写して送る（応答も System One の形へ戻して確かめる）
  const openai = decisionWireFor(up.url) === 'openai-decisions'
  const systemOne = DECISION_TEST_BODY(up.model)
  const converted = openai ? toOpenAiDecisions(systemOne, up.model) : null
  const body = JSON.stringify(converted?.ok ? converted.body : systemOne)
  const started = Date.now()
  const record = (status: number, extra: Partial<ApiCallRecord> = {}) => opt.onCall?.({
    ts: (opt.now?.() ?? new Date()).toISOString(), kind: 'decision', agent: 'connection test', provider: up.provider, model: up.model,
    status, latencyMs: Date.now() - started, requestBytes: Buffer.byteLength(body), images: 0, ...extra
  })
  let res: Response
  try {
    res = await (opt.fetch ?? fetch)(up.url, { method: 'POST', headers: { 'content-type': 'application/json', ...up.headers }, body, signal: AbortSignal.timeout(Math.min(up.timeoutMs, 60_000)) })
  } catch (err) {
    record(0)
    const timeout = (err as { name?: string } | null)?.name === 'TimeoutError'
    return { ok: false, message: t(timeout ? 'decision.test.timeout' : 'decision.test.unreachable'), model: up.model }
  }
  const latencyMs = Date.now() - started
  // 本文が読めない・JSON でない・大きすぎる（上限は boundedResponse.ts）ときは、答えが無いものとして扱う（想定内）
  const raw: unknown = await readBoundedJson(res, SMALL_JSON_MAX_BYTES).catch(() => null)
  const json: unknown = converted?.ok ? fromOpenAiDecisions(raw, converted.names) ?? raw : raw
  const usage = extractUsage(json)
  record(res.status, { ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd, costSource: 'provider' as const } : {}) })
  if (!res.ok) return { ok: false, message: describeTestFailure(res.status, up.model), model: up.model, latencyMs }
  if (!hasTestAnswer(json)) return { ok: false, message: t('decision.test.badResponse'), model: up.model, latencyMs }
  return { ok: true, message: t('decision.test.ok', { model: up.model, ms: latencyMs }), model: up.model, latencyMs }
}
