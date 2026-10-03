/**
 * 従量課金の API 呼び出しの記録と、その集計（フッター左下の使用量）。main と renderer の両方が読む。
 * 記録に入れるのは数だけ（画像・本文・キーは入れない）。src/main/decision/callLog.ts
 */

export type ApiCallKind = 'decision' | 'transcription' | 'organize'

export interface ApiCallRecord {
  /** ISO8601 */
  ts: string
  kind: ApiCallKind
  /** 呼んだときに開いていたプロジェクト */
  projectId?: string
  /** 呼んだ Agent（ターミナルのタブ名）。分かるときだけ */
  agent?: string
  /** プリセット・提供元（ollama / cloudflare / vercel …） */
  provider?: string
  model: string
  /** HTTP の状態。接続できなかったときは 0 */
  status: number
  latencyMs: number
  requestBytes?: number
  images?: number
  inputTokens?: number
  outputTokens?: number
  /** USD。分からなければ入れない */
  costUsd?: number
  /** provider は応答に入っていた額、estimate は設定の単価からの見積もり */
  costSource?: 'provider' | 'estimate'
  /** 文字起こしの音声の長さ（秒） */
  durationSec?: number
}

export interface ApiUsageTotals {
  calls: number
  /** 2xx 以外 */
  errors: number
  inputTokens: number
  outputTokens: number
  /** 費用が分かった呼び出しの合計 */
  costUsd: number
  /** 費用が分かった呼び出しの数（0 なら費用は「—」） */
  costKnown: number
}

export interface ApiUsageSummary {
  /** 判定モデルを有効にしているか */
  enabled: boolean
  /** 使っている判定モデル（有効なとき） */
  model: string | null
  provider: string | null
  today: ApiUsageTotals
  month: ApiUsageTotals
  /** プロジェクト ID ごと（'' はプロジェクトなし） */
  byProject: Record<string, ApiUsageTotals>
  byModel: Record<string, ApiUsageTotals>
  byKind: Partial<Record<ApiCallKind, ApiUsageTotals>>
  /** 新しい順に最大 50 件 */
  recent: ApiCallRecord[]
  /** 今月の記録のファイル */
  logFile: string
}

/** 「18.3k」のように縮めたトークン数 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 費用。分からなければ「—」（推測しない） */
export function formatCost(t: Pick<ApiUsageTotals, 'costUsd' | 'costKnown'> | { costUsd?: number }): string {
  if ('costKnown' in t) return t.costKnown > 0 ? `$${t.costUsd < 0.01 && t.costUsd > 0 ? t.costUsd.toFixed(4) : t.costUsd.toFixed(2)}` : '—'
  return t.costUsd === undefined ? '—' : `$${t.costUsd < 0.01 && t.costUsd > 0 ? t.costUsd.toFixed(4) : t.costUsd.toFixed(2)}`
}

/** プロジェクトごとの合計の見出し。名前が分かればその名前、消したプロジェクトは ID、ID が空なら noProject */
export function projectLabel(id: string, names: Record<string, string>, noProject: string): string {
  if (!id) return noProject
  return names[id] ?? id
}
