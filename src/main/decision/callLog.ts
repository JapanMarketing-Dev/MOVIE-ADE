/**
 * 従量課金の API 呼び出しの記録（判定モデル・文字起こし・整理）。フッター左下の使用量に使う。
 *
 * 1回の呼び出しを JSONL の1行にし、月ごとのファイル（<設定フォルダ>/usage/decision-YYYY-MM.jsonl）へ追記する。
 * 残すのは件数・時刻・モデル・状態・トークン数・費用などの数だけ。**画像・state・問いの文・キーは残さない。**
 * 費用は応答に入っていればそれ（Vercel AI Gateway の provider_metadata.gateway.cost）、無ければ利用者が設定した
 * 100 万トークンあたりの単価から見積もる。どちらも無ければ null（推測しない）。
 *
 * Electron に依存させない（単体テストで一時フォルダに書くため）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiCallKind, ApiCallRecord, ApiUsageTotals, ApiUsageSummary } from '@shared/apiUsage'
import type { DecisionPricing } from '@shared/decision'
import { errorKind, reportHandled } from '@shared/report'

export type { ApiCallRecord } from '@shared/apiUsage'

const pad = (n: number) => String(n).padStart(2, '0')

/** その月のファイル名（ローカル時刻の月で分ける） */
export function callLogFile(dir: string, at: Date): string {
  return join(dir, `decision-${at.getFullYear()}-${pad(at.getMonth() + 1)}.jsonl`)
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/**
 * 応答の本文からトークン数と費用を取り出す。Cloudflare の { result: {...}, success } の包みも見る。
 * 読めなければ空（本文そのものは残さない）
 */
export function extractUsage(body: unknown): { inputTokens?: number; outputTokens?: number; costUsd?: number } {
  const top = rec(body)
  const inner = rec(top.result)
  const usage = rec(top.usage ?? inner.usage)
  const gateway = rec(rec(top.provider_metadata ?? inner.provider_metadata).gateway)
  const cost = num(typeof gateway.cost === 'string' ? Number(gateway.cost) : gateway.cost)
  const input = num(usage.input_tokens ?? usage.prompt_tokens)
  const output = num(usage.output_tokens ?? usage.completion_tokens)
  return { ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) }
}

/** 単価が設定されているときだけ見積もる。トークン数か単価が欠けていれば undefined */
export function estimateCost(tokens: { inputTokens?: number; outputTokens?: number }, pricing: DecisionPricing | undefined): number | undefined {
  if (!pricing || (pricing.inputPer1M === undefined && pricing.outputPer1M === undefined)) return undefined
  if (tokens.inputTokens === undefined && tokens.outputTokens === undefined) return undefined
  if ((tokens.inputTokens && pricing.inputPer1M === undefined) || (tokens.outputTokens && pricing.outputPer1M === undefined)) return undefined
  return ((tokens.inputTokens ?? 0) * (pricing.inputPer1M ?? 0) + (tokens.outputTokens ?? 0) * (pricing.outputPer1M ?? 0)) / 1_000_000
}

const KINDS: readonly ApiCallKind[] = ['decision', 'transcription', 'organize']

/** 読み込んだ1行を型どおりに直す。壊れた行は捨てる。知らない項目（本文など）は持ち込まない */
export function sanitizeCallRecord(raw: unknown): ApiCallRecord | null {
  const r = rec(raw)
  if (typeof r.ts !== 'string' || Number.isNaN(Date.parse(r.ts)) || !KINDS.includes(r.kind as ApiCallKind) || typeof r.model !== 'string') return null
  const s = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : undefined)
  const out: ApiCallRecord = { ts: r.ts, kind: r.kind as ApiCallKind, model: r.model.slice(0, 200), status: num(r.status) ?? 0, latencyMs: num(r.latencyMs) ?? 0 }
  const optional = { projectId: s(r.projectId), agent: s(r.agent), provider: s(r.provider), requestBytes: num(r.requestBytes), images: num(r.images),
    inputTokens: num(r.inputTokens), outputTokens: num(r.outputTokens), costUsd: num(r.costUsd),
    costSource: r.costSource === 'provider' || r.costSource === 'estimate' ? r.costSource : undefined, durationSec: num(r.durationSec) }
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v
  return out
}

export class CallLog {
  /** 同じファイルへの追記を順番に行う */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  /** 1件を追記する。失敗しても呼び出し元（中継の応答）は止めない */
  append(record: ApiCallRecord): Promise<void> {
    const clean = sanitizeCallRecord(record)
    if (!clean) return Promise.resolve()
    const next = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(callLogFile(this.dir, new Date(clean.ts)), `${JSON.stringify(clean)}\n`, 'utf8')
    }).catch((err: unknown) => {
      // 記録できないだけ（使用量の表示が欠ける）。パスを含みうるので種類だけを送る
      console.warn('[usage] API 呼び出しの記録を書けませんでした')
      reportHandled(errorKind(err), { area: 'usage', op: 'append api call log' })
    })
    this.queue = next
    return next
  }

  /** その月の記録（壊れた行は飛ばす） */
  async month(at: Date = this.now()): Promise<ApiCallRecord[]> {
    let text: string
    try { text = await readFile(callLogFile(this.dir, at), 'utf8') } catch { return [] } // まだ呼んでいない月はファイルが無い（想定内）
    return text.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try { const r = sanitizeCallRecord(JSON.parse(line)); return r ? [r] : [] } catch { return [] } // 書きかけの行（想定内）
    })
  }

  /** 今月の記録をまとめる */
  async summary(extra: Omit<ApiUsageSummary, 'today' | 'month' | 'byProject' | 'byModel' | 'byKind' | 'recent' | 'logFile'>): Promise<ApiUsageSummary> {
    const now = this.now()
    return { ...extra, ...aggregateCalls(await this.month(now), now), logFile: callLogFile(this.dir, now) }
  }
}

function emptyTotals(): ApiUsageTotals {
  return { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: 0 }
}

function add(t: ApiUsageTotals, r: ApiCallRecord): void {
  t.calls++
  if (r.status < 200 || r.status >= 300) t.errors++
  t.inputTokens += r.inputTokens ?? 0
  t.outputTokens += r.outputTokens ?? 0
  if (r.costUsd !== undefined) { t.costUsd += r.costUsd; t.costKnown++ }
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** 今日・今月・プロジェクトごと・モデルごと・種類ごとの合計と、直近 50 件 */
export function aggregateCalls(records: readonly ApiCallRecord[], now: Date): Pick<ApiUsageSummary, 'today' | 'month' | 'byProject' | 'byModel' | 'byKind' | 'recent'> {
  const today = emptyTotals()
  const month = emptyTotals()
  const byProject: Record<string, ApiUsageTotals> = {}
  const byModel: Record<string, ApiUsageTotals> = {}
  const byKind: Partial<Record<ApiCallKind, ApiUsageTotals>> = {}
  for (const r of records) {
    const at = new Date(r.ts)
    if (at.getFullYear() !== now.getFullYear() || at.getMonth() !== now.getMonth()) continue
    add(month, r)
    if (sameDay(at, now)) add(today, r)
    add(byProject[r.projectId ?? ''] ??= emptyTotals(), r)
    add(byModel[r.model] ??= emptyTotals(), r)
    add(byKind[r.kind] ??= emptyTotals(), r)
  }
  return { today, month, byProject, byModel, byKind, recent: records.slice(-50).reverse() }
}

/** 文字起こし・整理など、中継を通らない呼び出しを記録する口（main の index.ts が差し込む） */
let sink: ((record: ApiCallRecord) => void) | null = null

export function setApiCallSink(next: ((record: ApiCallRecord) => void) | null): void {
  sink = next
}

/** ADE 自身の BYOK の呼び出し（文字起こし・整理）を記録する。差し込まれていなければ何もしない */
export function recordApiCall(record: Omit<ApiCallRecord, 'ts'> & { ts?: string }): void {
  sink?.({ ts: new Date().toISOString(), ...record })
}
