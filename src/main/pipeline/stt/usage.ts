/**
 * 文字起こしの送信を、フッターの「API の使用量」の記録（src/main/decision/callLog.ts）へ載せる。
 * 数だけを渡す（音声・本文・キーは渡さない）。失敗した送信（4xx・5xx、つながらなければ状態 0）も記録する。
 * 費用は、プリセットの単価が分かるときだけ見積もりとして付ける（分からなければ付けない）。
 */
import { recordApiCall } from '../../decision/callLog'

export interface SttCallMeta {
  provider?: string
  model: string
  /** 送った音声の長さ(秒) */
  durationSec: number
  requestBytes: number
  /** 単価から見積もった費用。単価が分からなければ undefined */
  estimateUsd?: number
}

/** fetch して、結果（状態・かかった時間）を記録する。投げた例外はそのまま返す */
export async function recordedSttFetch(url: string, init: RequestInit, meta: SttCallMeta): Promise<Response> {
  const started = Date.now()
  const record = (status: number) => recordApiCall({
    kind: 'transcription', ...(meta.provider ? { provider: meta.provider } : {}), model: meta.model, status, latencyMs: Date.now() - started,
    durationSec: meta.durationSec, requestBytes: meta.requestBytes,
    // 失敗した送信には課金されない前提で、費用は成功したときだけ
    ...(status >= 200 && status < 300 && meta.estimateUsd !== undefined ? { costUsd: meta.estimateUsd, costSource: 'estimate' as const } : {}),
  })
  try {
    const res = await fetch(url, init)
    record(res.status)
    return res
  } catch (e) {
    record(0)
    throw e
  }
}
